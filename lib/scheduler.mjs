import {problem} from './job-input.mjs';
export class Scheduler {
 constructor({store,hub,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval}){Object.assign(this,{store,hub,clock,setTimer,clearTimer});this.active=new Map();this.failed=null;this.running=false;}
 start(){this.store.recover(this.clock());this.timer=this.setTimer(()=>this.tick(),1000);this.tick();}
 stop(){if(this.timer)this.clearTimer(this.timer);this.timer=null;for(const call of this.active.values())call.hangup();}
 assertHealthy(){if(this.failed)throw problem('Хранилище scheduler недоступно. Новые звонки остановлены',503);}
 fail(error){this.failed=error;if(this.timer)this.clearTimer(this.timer);this.timer=null;for(const call of this.active.values())call.hangup();console.error('Scheduler остановлен:',error.message);}
 tick(){
  if(this.running||this.failed)return;this.running=true;
  try{
   const now=this.clock();
   for(const job of this.store.runnable()){
    const due=Date.parse(job.scheduledAt);if(due>now)continue;
    if(now-due>120000){this.store.updateAttempt(job.id,{state:'missed',reason:'Время запуска пропущено'});continue;}
    const available=this.hub?.availability()??{ready:false,busy:false,reason:'Мост с АТС не настроен'};
    if(!available.ready||available.busy){this.store.updateAttempt(job.id,{state:'waiting',reason:available.reason});continue;}
    const claimed=this.store.claim(job.id,now);if(!claimed)continue;
    let call;
    try{
     call=this.hub.start({to:job.to,name:job.name,session:job.brief.session,label:job.brief.profile.label,profileId:job.brief.profile.id,record:false,maxDurationSeconds:job.maxDurationSeconds});
     this.active.set(job.id,call);
     const persist=()=>{try{this.store.updateAttempt(job.id,{callId:call.id,result:call.result()});}catch(e){this.fail(e);}};
     call.on('event',e=>{if(e.type!=='meter')persist();});
     call.once('closed',()=>{
      this.active.delete(job.id);
      try{const result=call.result();this.store.updateAttempt(job.id,{state:result.cleanupConfirmed?(result.answeredAt?'completed':'failed'):'unknown',result,reason:result.reason??'Завершение не подтверждено'});}catch(e){this.fail(e);}
     });
     this.store.updateAttempt(job.id,{state:'active',reason:'',callId:call.id,result:call.result()});
    }catch(error){
     if(call){this.fail(error);}
     else this.store.updateAttempt(job.id,{state:'unknown',reason:error.message});
    }
    break;
   }
  }catch(e){this.fail(e);}finally{this.running=false;}
 }
 stopJob(id){this.assertHealthy();const job=this.store.getJob(id);if(!job)throw problem('Задание не найдено',404);const call=this.active.get(id);if(call){call.hangup();return {...job,stopping:true};}if(['dispatching','active'].includes(job.state))throw problem('Нет подтверждённой активной сессии. Исход требует проверки',409);return job;}
}

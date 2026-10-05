// Ошибка session.start и потеря Live-сокета должны завершать PBX-плечо.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import { PhoneCall } from '../lib/calls.mjs';
import { once } from 'node:events';

for (const failure of ['start-error','socket-close']) {
  test(`PBX cleanup при ${failure}`, async()=>{
    const server=new WebSocketServer({port:0});
    await once(server,'listening');
    const hangups=[];
    const hub={openai:new OpenAI({apiKey:'test',baseURL:`http://127.0.0.1:${server.address().port}/v1`}),calls:new Map(),finished:new Map(),hangup:s=>hangups.push(s),sendAudio:()=>{}};
    const peer=once(server,'connection');
    const call=new PhoneCall(hub,1,{to:'test:sim1',session:{model:'gpt-live-1'}});
    hub.calls.set(1,call);
    const [ws]=await peer;
    const closed=once(call,'closed');
    call.onBridge({state:'answered',id:'fixture'});
    if(failure==='start-error') ws.send(JSON.stringify({type:'error',error:{code:'model_not_found',message:'fixture'}}));
    else ws.close();
    try {
      await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('PBX cleanup timeout')),500))]);
      assert.equal(call.state,'ended');
      assert.deepEqual(hangups,[1]);
      assert.equal(hub.calls.size,0);
    } finally {
      clearInterval(call.meterTimer);
      call.liveState='closed';
      call.teardown();
      for(const socket of server.clients) socket.terminate();
      server.close();
    }
  });
}
test('PBX ended then Live socket close completes teardown once',async t=>{
 const server=new WebSocketServer({port:0});await once(server,'listening');const hub={openai:new OpenAI({apiKey:'test',baseURL:`http://127.0.0.1:${server.address().port}/v1`}),calls:new Map(),finished:new Map(),pendingCleanup:new Set(),pendingLive:new Set(),hangup(){},sendAudio(){}};
 const peer=once(server,'connection');const call=new PhoneCall(hub,1,{to:'test:sim1',session:{model:'gpt-live-1'}});hub.calls.set(1,call);const [ws]=await peer;
 call.onBridge({state:'answered',id:'fixture'});call.onLive({type:'session.started',session:{id:'live'}});call.onBridge({state:'ended',reason:'Normal Clearing'});
 ws.close();await new Promise(r=>setTimeout(r,100));
 try{assert.equal(call.teardownDone,true);assert.equal(hub.calls.size,0);assert.equal(call.result().cleanupConfirmed,true);}finally{call.teardown();for(const s of server.clients)s.terminate();server.close();}
});
test('duration limit starts at answer and duplicate answer cannot extend it',async t=>{
 const server=new WebSocketServer({port:0});await once(server,'listening');const hangups=[];const hub={openai:new OpenAI({apiKey:'test',baseURL:`http://127.0.0.1:${server.address().port}/v1`}),calls:new Map(),finished:new Map(),hangup:s=>hangups.push(s),sendAudio(){}};
 const peer=once(server,'connection');const call=new PhoneCall(hub,1,{to:'test:sim1',session:{model:'gpt-live-1'},maxDurationSeconds:30});hub.calls.set(1,call);const [ws]=await peer;
 clearTimeout(call.dialTimer);t.mock.timers.enable({apis:['setTimeout']});call.onBridge({state:'answered'});call.onLive({type:'session.started',session:{id:'fixture'}});t.mock.timers.tick(29999);assert.equal(hangups.length,0);call.onBridge({state:'answered'});t.mock.timers.tick(1);assert.equal(hangups.length,1);call.onBridge({state:'ended'});call.onLive({type:'session.closed',usage:{seconds:30}});assert.equal(call.result().usage.seconds,30);
 call.teardown();t.mock.timers.reset();for(const s of server.clients)s.terminate();server.close();
});

import {randomUUID} from "node:crypto";
import {validateJobInput,validateContact,problem} from './job-input.mjs';
export function mountJobsApi(app,{store,scheduler,buildBrief,clock=Date.now,allowedOrigins}){
 const previews=new Map();
 const payloadOf=body=>{const {previewToken,...payload}=body;return JSON.stringify(payload);};
 const healthy=()=>{if(!store||!scheduler)throw problem('Хранилище scheduler недоступно. Новые звонки остановлены',503);scheduler.assertHealthy();};
 const handler=fn=>async(req,res)=>{try{if(req.method!=='GET'&&req.headers.origin&&!allowedOrigins.has(req.headers.origin))throw problem('Запрос пришёл с неизвестного адреса',403);healthy();await fn(req,res);}catch(e){res.status(e.status??503).json({error:e.message,field:e.field});}};
 const publicJob=j=>{const {brief,...rest}=j;return {...rest,callState:j.result?.callState,profileLabel:brief?.profile?.label,voice:brief?.session?.audio?.output?.voice};};
 app.post('/api/jobs/preview',handler(async(req,res)=>{const input=validateJobInput(req.body,clock());const brief=await buildBrief(input);for(const [k,v] of previews)if(v.expires<clock())previews.delete(k);
 const previewToken=randomUUID();previews.set(previewToken,{brief,payload:payloadOf(req.body),expires:clock()+600000});while(previews.size>100)previews.delete(previews.keys().next().value);
 res.json({...input,previewToken,profileLabel:brief.profile.label,voice:brief.session.audio.output.voice});}));
 app.post('/api/jobs',handler(async(req,res)=>{
  const key=req.get('Idempotency-Key');if(!key||key.length>100)throw problem('Нужен Idempotency-Key до 100 символов');
  const old=store.findKey(key);if(old){res.json(publicJob(store.createJob(old,key,req.body)));return;}
  const input=validateJobInput(req.body,clock());let brief;
  if(req.body.previewToken){const preview=previews.get(req.body.previewToken);if(!preview||preview.expires<clock())throw problem('Проверка устарела. Проверьте карточку ещё раз',409);if(preview.payload!==payloadOf(req.body))throw problem('Форма изменилась после проверки',409);brief=preview.brief;}else brief=await buildBrief(input);
  const job=store.createJob({...input,brief},key,req.body);res.status(201).json(publicJob(job));
 }));
 app.get('/api/jobs',handler((req,res)=>res.json({jobs:store.listJobs().map(j=>{const p=publicJob(j);delete p.instructions;delete p.context;delete p.files;delete p.result;return p;}),scheduler:{available:!scheduler.failed}})));
 app.get('/api/jobs/:id',handler((req,res)=>{const j=store.getJob(req.params.id);if(!j)throw problem('Задание не найдено',404);res.json(publicJob(j));}));
 app.delete('/api/jobs/:id',handler((req,res)=>res.json(publicJob(store.cancel(req.params.id)))));
 app.post('/api/jobs/:id/stop',handler((req,res)=>res.json(publicJob(scheduler.stopJob(req.params.id)))));
 app.get('/api/contacts',handler((req,res)=>res.json(store.listContacts())));
 app.post('/api/contacts',handler((req,res)=>res.status(201).json(store.saveContact(validateContact(req.body)))));
 app.delete('/api/contacts/:id',handler((req,res)=>{if(!store.deleteContact(req.params.id))throw problem('Контакт не найден',404);res.json({ok:true});}));
}

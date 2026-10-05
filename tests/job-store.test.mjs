import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openJobStore} from '../lib/job-store.mjs';
const now=Date.parse('2026-10-05T09:00:00Z');
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'jobs-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return join(dir,'calls.sqlite');}
test('persistence idempotency cancel claim recovery',t=>{
 const path=fixture(t);let store=openJobStore({path,clock:()=>now});
 const input={to:'test:sim1',scheduledAt:new Date(now).toISOString(),brief:{session:{}},maxDurationSeconds:300};
 const a=store.createJob(input,'key-a'); assert.equal(store.createJob(input,'key-a').id,a.id);
 assert.throws(()=>store.createJob({...input,to:'test:sim2'},'key-a'));
 store.saveContact({name:'Тест',to:'test:sim1'});assert.ok(store.claim(a.id,now));assert.equal(store.claim(a.id,now),null);assert.throws(()=>store.cancel(a.id));
 const b=store.createJob(input,'key-b');store.cancel(b.id);assert.equal(store.claim(b.id,now),null);
 store.close();store=openJobStore({path,clock:()=>now});store.recover(now);
 assert.equal(store.getJob(a.id).state,'unknown');assert.equal(store.getJob(b.id).state,'cancelled');assert.equal(store.listContacts().length,1);store.close();
});
test('lock prevents a second owner and corrupt database stays corrupt',t=>{
 const path=fixture(t);const store=openJobStore({path});assert.throws(()=>openJobStore({path}));store.close();
 writeFileSync(path,'corrupt');assert.throws(()=>openJobStore({path}));
});
test('missed window and stale claims are terminal',t=>{
 const store=openJobStore({path:fixture(t),clock:()=>now});
 const job=store.createJob({scheduledAt:new Date(now-120001).toISOString()},'late');store.recover(now);assert.equal(store.getJob(job.id).state,'missed');assert.equal(store.claim(job.id,now),null);store.close();
});
test('unknown lock and PID reuse fail closed; dead owner recovers',t=>{
 const path=fixture(t);writeFileSync(path+'.lock','{}');assert.throws(()=>openJobStore({path}));
 writeFileSync(path+'.lock',JSON.stringify({pid:process.pid,start:'different-start',nonce:'old'}));assert.throws(()=>openJobStore({path}));
 writeFileSync(path+'.lock',JSON.stringify({pid:2147483647,start:'old',nonce:'old'}));const store=openJobStore({path});store.close();
});
test('unchanged waiting status does not rewrite update timestamp',t=>{let time=now;const store=openJobStore({path:fixture(t),clock:()=>time});const job=store.createJob({scheduledAt:new Date(now).toISOString()},'stable');store.updateAttempt(job.id,{state:'waiting',reason:'busy'});const stamp=store.getJob(job.id).updatedAt;time+=1000;store.updateAttempt(job.id,{state:'waiting',reason:'busy'});assert.equal(store.getJob(job.id).updatedAt,stamp);store.close();});
test('read-only directory fails without replacing existing database',t=>{const path=fixture(t);let store=openJobStore({path});store.close();const dir=path.slice(0,path.lastIndexOf('/'));chmodSync(dir,0o500);try{assert.throws(()=>openJobStore({path}));}finally{chmodSync(dir,0o700);}store=openJobStore({path});assert.deepEqual(store.listJobs(),[]);store.close();});

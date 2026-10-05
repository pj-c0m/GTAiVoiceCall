import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,openSync,writeFileSync,readFileSync,closeSync,unlinkSync,chmodSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {problem} from './job-input.mjs';
const terminal=new Set(['completed','failed','cancelled','missed','unknown']);
function identity(pid){return execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8'}).trim();}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export function openJobStore({path='data/calls.sqlite',clock=Date.now}={}){
 path=resolve(path);mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const lock=path+'.lock';const owner={pid:process.pid,start:identity(process.pid),nonce:randomUUID()};
 if(!owner.start)throw problem('Не удалось установить владельца scheduler',503);
 let fd;
 try{fd=openSync(lock,'wx',0o600);}catch(error){
  if(error.code!=='EEXIST')throw error;
  let prior;try{prior=JSON.parse(readFileSync(lock,'utf8'));if(!Number.isInteger(prior.pid)||!prior.start)throw Error();}catch{throw problem('Неизвестный владелец scheduler lock',503);}
  try{process.kill(prior.pid,0);throw problem('Scheduler уже запущен либо PID переиспользован',503);}catch(e){if(e.code!=='ESRCH')throw e;}
  const recovery=lock+'.recovery';let guard;
  try { guard=openSync(recovery,'wx',0o600); } catch { throw problem('Scheduler lock уже восстанавливается; требуется проверка владельца',503); }
  try {
    const current=JSON.parse(readFileSync(lock,'utf8'));
    if(current.nonce!==prior.nonce)throw problem('Владелец scheduler изменился',503);
    unlinkSync(lock);fd=openSync(lock,'wx',0o600);
  } finally { closeSync(guard);unlinkSync(recovery); }
 }
 writeFileSync(fd,JSON.stringify(owner));closeSync(fd);
 const release=()=>{if(JSON.parse(readFileSync(lock,'utf8')).nonce===owner.nonce)unlinkSync(lock);};
 let db;
 try{
  db=new DatabaseSync(path);chmodSync(path,0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  const version=db.prepare('PRAGMA user_version').get().user_version;if(version>1)throw Error('Неизвестная версия БД');
  db.exec('CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, due INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1;');
 }catch(e){db?.close();release();throw e;}
 let closed=false;
 const row=r=>r?JSON.parse(r.data):null;
 const save=j=>db.prepare('UPDATE jobs SET state=?,data=? WHERE id=?').run(j.state,JSON.stringify(j),j.id);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const getJob=id=>row(db.prepare('SELECT data FROM jobs WHERE id=?').get(id));
 return {
  findKey(key){return row(db.prepare("SELECT data FROM jobs WHERE key=?").get(key));},
  createJob(input,key,fingerprint=input){return tx(()=>{
   const hash=createHash('sha256').update(JSON.stringify(canonical(fingerprint))).digest('hex');const existing=db.prepare('SELECT * FROM jobs WHERE key=?').get(key);
   if(existing){if(existing.hash!==hash)throw problem('Этот ключ уже использован для другого звонка',409);return row(existing);}
   if(db.prepare('SELECT COUNT(*) n FROM jobs').get().n>=10000)throw problem('Достигнут лимит 10000 заданий',413);
   const job={...input,id:randomUUID(),state:'scheduled',createdAt:new Date(clock()).toISOString(),attemptId:null,callId:null,result:null};
   db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?)').run(job.id,key,hash,job.state,Date.parse(input.scheduledAt),JSON.stringify(job));return job;
  });},
  getJob,
  listJobs({limit=100}={}){return db.prepare('SELECT data FROM jobs ORDER BY due DESC,id LIMIT ?').all(Math.min(500,Math.max(1,limit))).map(row);},
  runnable(){return db.prepare("SELECT data FROM jobs WHERE state IN ('scheduled','waiting') ORDER BY due,id").all().map(row);},
  claim(id,now){return tx(()=>{const j=getJob(id);if(!j||!['scheduled','waiting'].includes(j.state)||Date.parse(j.scheduledAt)>now||now-Date.parse(j.scheduledAt)>120000)return null;j.state='dispatching';j.attemptId=randomUUID();save(j);return j;});},
  cancel(id){return tx(()=>{const j=getJob(id);if(!j)throw problem('Задание не найдено',404);if(j.state==='cancelled')return j;if(!['scheduled','waiting'].includes(j.state))throw problem('Попытка уже началась. Используйте остановку',409);j.state='cancelled';save(j);return j;});},
  updateAttempt(id,patch){return tx(()=>{const j=getJob(id);if(!j)throw problem('Задание не найдено',404);if(terminal.has(j.state))return j;Object.assign(j,patch);save(j);return j;});},
  recover(now){return tx(()=>{for(const r of db.prepare("SELECT data FROM jobs WHERE state IN ('dispatching','active','scheduled','waiting')").all()){const j=row(r);if(['dispatching','active'].includes(j.state)){j.state='unknown';j.reason='Процесс остановился во время попытки';}else if(now-Date.parse(j.scheduledAt)>120000){j.state='missed';j.reason='Время запуска пропущено';}save(j);}});},
  saveContact(input){if(db.prepare('SELECT COUNT(*) n FROM contacts').get().n>=1000)throw problem('Лимит 1000 контактов',413);const c={...input,id:randomUUID()};db.prepare('INSERT INTO contacts VALUES(?,?)').run(c.id,JSON.stringify(c));return c;},
  listContacts(){return db.prepare('SELECT data FROM contacts ORDER BY id').all().map(row);},
  deleteContact(id){return db.prepare('DELETE FROM contacts WHERE id=?').run(id).changes>0;},
  close(){if(closed)return;closed=true;db.close();release();}
 };
}

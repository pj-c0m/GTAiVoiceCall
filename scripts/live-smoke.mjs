// Прямой PCMA/Live WebSocket smoke с явным key из dotenv, без звонка и ambient key.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import OpenAI from 'openai';
import { LiveWS } from 'openai/resources/live/ws';
import { loadProfiles, sessionFor } from '../lib/profiles.mjs';
const e=parseEnv(readFileSync(process.argv[2]||'.env','utf8'));
if (!e.OPENAI_API_KEY) throw new Error('В выбранном dotenv нет OPENAI_API_KEY');
const client=new OpenAI({apiKey:e.OPENAI_API_KEY,project:e.OPENAI_PROJECT_ID||e.OPENAI_PROJECT||null,organization:e.OPENAI_ORG_ID||null});
const ws=new LiveWS(client);
let started=false,closed=false;
const deadline=setTimeout(()=>{console.log('TIMEOUT');ws.close();process.exitCode=1;},20000);
ws.on('event',event=>{
 if(event.type==='session.started'){started=true;console.log('session.started',event.session?.id);setTimeout(()=>ws.send({type:'session.close'}),2000);}
 if(event.type==='session.closed'){closed=true;console.log('session.closed',JSON.stringify(event.usage));clearTimeout(deadline);ws.close();}
 if(event.type==='error')console.log('API error',event.error?.code,event.error?.type);
});
ws.on('error',()=>{clearTimeout(deadline);process.exitCode=1;ws.close();});
ws.socket.on('close',()=>{clearTimeout(deadline);if(!started||!closed)process.exitCode=1;console.log('result',started&&closed?'PASS':'FAIL');});
const profiles=await loadProfiles();
ws.send({type:'session.start',event_id:'smoke',session:sessionFor(profiles.get('free'),{phone:true,voice:'marin',backendModel:e.LIVE_BACKEND_MODEL||'gpt-6-luna'})});

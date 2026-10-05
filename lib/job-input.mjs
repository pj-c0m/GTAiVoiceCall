import { randomUUID } from 'node:crypto';
export function problem(message,status=400,field){return Object.assign(new Error(message),{status,field});}
function text(value,label,max,required=false){if(value===undefined&&!required)return '';if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw problem(`${label}: проверьте значение (до ${max} символов)`,400,({Номер:"to",Имя:"name",Тема:"topic",Цель:"goal",Инструкции:"instructions",Контекст:"context",Сценарий:"profile",Голос:"voice","Имя файла":"files","Текст файла":"files"})[label]);return value.trim();}
export function validateContact(body){
 const raw=text(body.to,'Номер',64,true);const to=raw==='test:sim1'?raw:raw.replace(/[\s()+-]/g,'');
 if(!/^7\d{10}$/.test(to)&&to!=='test:sim1')throw problem('Введите номер +7 и ещё 10 цифр',400,'to');
 return {name:text(body.name,'Имя',60),to:to==='test:sim1'?to:'+'+to};
}
export function resolveTime({localTime,timeZone}){
 if(typeof timeZone!=="string"||!timeZone.trim())throw problem("Укажите часовой пояс IANA",400,"timeZone");
 if(typeof localTime!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(localTime))throw problem('Укажите дату и время',400,'localTime');
 let fmt;try{fmt=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}catch{throw problem('Неизвестный часовой пояс',400,'timeZone');}
 const wall=Date.parse(localTime+'Z');if(!Number.isFinite(wall)||new Date(wall).toISOString().slice(0,16)!==localTime)throw problem('Некорректная дата',400,'localTime');
 const render=ms=>{const p=Object.fromEntries(fmt.formatToParts(ms).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;};
 const hits=[];
 for(let offset=-14*60;offset<=14*60;offset++){const instant=wall-offset*60000;if(render(instant)===localTime)hits.push({instant,offset});}
 if(hits.length!==1)throw problem('Это время отсутствует или неоднозначно при смене часового пояса. Выберите другое время',400,'localTime');
 const {instant,offset}=hits[0];return {scheduledAt:new Date(instant).toISOString(),localTime,timeZone,offset:`${offset<0?'-':'+'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`};
}
export function validateJobInput(body,now=Date.now()){
 if(!body||typeof body!=='object')throw problem('Нужна форма звонка');
 const contact=validateContact(body);const maxDurationSeconds=body.maxDurationSeconds??300;
 if(!Number.isInteger(maxDurationSeconds)||maxDurationSeconds<30||maxDurationSeconds>1800)throw problem('Длительность: от 30 до 1800 секунд',400,'maxDurationSeconds');
 const when=body.when??'now';if(!['now','scheduled'].includes(when))throw problem('Выберите время звонка');
 const time=when==='now'?{scheduledAt:new Date(now).toISOString(),timeZone:'Europe/Moscow',localTime:null,offset:'+03:00'}:resolveTime(body);
 if(when==='scheduled'&&Date.parse(time.scheduledAt)<=now)throw problem('Выберите время в будущем',400,'localTime');
 if(body.files!==undefined&&!Array.isArray(body.files))throw problem('Неверный список файлов');
 const files=(body.files??[]).map(f=>({name:text(f?.name,'Имя файла',120,true),text:text(f?.text,'Текст файла',120000,true)}));
 if(files.length>50||files.reduce((n,f)=>n+f.text.length,0)>120000)throw problem('Файлы: до 50 файлов и 120000 символов',413);
 return {...contact,...time,when,maxDurationSeconds,topic:text(body.topic,'Тема',200),goal:text(body.goal,'Цель',6000),instructions:text(body.instructions,'Инструкции',40000),context:text(body.context,'Контекст',6000),profile:text(body.profile,'Сценарий',120),voice:text(body.voice,'Голос',60),files};
}
export const newKey=()=>randomUUID();

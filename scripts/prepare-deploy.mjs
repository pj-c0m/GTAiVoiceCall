// Безопасная проекция конфигурации: общий dotenv никогда не копируется на сервер.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, cpSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [configPath, output, mode] = process.argv.slice(2);
if (!configPath || !output || !['model', 'pbx'].includes(mode)) throw new Error('Нужны CONFIG OUTPUT model|pbx');
const e = parseEnv(readFileSync(configPath, 'utf8'));
const required = ['MVP_CONFIG_COMPLETE', 'MODEL_SSH', 'PBX_SSH', 'OPENAI_API_KEY', 'PBX_EXTENSION', 'PBX_DOMAIN', 'PBX_SIP_PASSWORD', 'BRIDGE_DOMAIN', 'ADMIN_EMAIL', 'ALLOWED_NUMBERS'];
for (const k of required) if (!e[k]) throw new Error(`Не заполнено ${k}`);
if (e.MVP_CONFIG_COMPLETE !== 'yes' || !/^7\d{10}$/.test(e.ALLOWED_NUMBERS)) throw new Error('Конфигурация не подтверждена или allowlist не содержит единственный номер');
if ((e.PBX_SIP_TRANSPORT || 'udp') !== 'udp' || (e.PBX_CODEC || 'alaw') !== 'alaw') throw new Error('MVP1 требует UDP и PCMA');
for (const [k,v] of Object.entries(e)) if (/[\r\n\0]/.test(v)) throw new Error(`Многострочное значение ${k} запрещено`);
const generatedPath = resolve(process.env.MVP_DEPLOY_STATE_PATH || '.deployment-secrets.env');
let generated = existsSync(generatedPath) ? parseEnv(readFileSync(generatedPath, 'utf8')) : {};
for (const k of ['BRIDGE_TOKEN', 'ARI_PASSWORD']) {
  e[k] ||= generated[k] || randomBytes(24).toString('hex');
  generated[k] = e[k];
}
writeFileSync(generatedPath, Object.entries(generated).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n', {mode:0o600});
chmodSync(generatedPath, 0o600);
e.BRIDGE_URL ||= `wss://${e.BRIDGE_DOMAIN}/pbx/bridge`;
e.BRIDGE_ALLOW ||= e.MODEL_PUBLIC_IPV4 || e.MODEL_SSH.split('@').at(-1);
e.PBX_PUBLIC_IPV4 ||= e.PBX_SSH.split('@').at(-1);
if (!/^\d+\.\d+\.\d+\.\d+$/.test(e.PBX_PUBLIC_IPV4)) throw new Error('Укажите PBX_PUBLIC_IPV4 для SSH alias');
if (!e.BRIDGE_ALLOW.split(',').every(x=>/^[0-9a-fA-F:.\/]+$/.test(x.trim()))) throw new Error('Укажите BRIDGE_ALLOW для SSH alias');
if (!/^[a-zA-Z0-9.-]+$/.test(e.BRIDGE_DOMAIN) || !/^[a-zA-Z0-9.-]+$/.test(e.PBX_DOMAIN)) throw new Error('Некорректное имя домена');
if (!['5060','60000'].includes(process.env.MVP_SIP_PORT || e.PBX_SIP_PORT || '5060')) throw new Error('Неподдерживаемый SIP port');
e.ARI_USER ||= 'dialer';
mkdirSync(output, {recursive:true, mode:0o700});
chmodSync(output, 0o700);
const write = (name, content) => writeFileSync(resolve(output,name), content, {mode:0o600});
if (mode === 'model') {
  const keys = ['OPENAI_API_KEY','LIVE_BACKEND_MODEL','DEFAULT_VOICE','PORT','HOST','SESSIONS_PER_IP_HOUR','SESSIONS_TOTAL_HOUR','BRIDGE_URL','BRIDGE_TOKEN'];
  if(e.OPENAI_PROJECT_ID) e.OPENAI_PROJECT=e.OPENAI_PROJECT_ID;
    keys.push('OPENAI_PROJECT','OPENAI_ORG_ID');
  write('.env', keys.filter(k=>e[k]).map(k=>`${k}=${JSON.stringify(e[k])}`).join('\n')+'\n');
  mkdirSync(resolve(output,'scripts'), {recursive:true});
  for (const name of ['scripts/calls.mjs','scripts/live-smoke.mjs']) cpSync(name,resolve(output,name));
  for (const name of ['server.mjs','package.json','package-lock.json','lib','public','profiles','model-server']) cpSync(name,resolve(output,name),{recursive:true});
} else {
  const dns = spawnSync('dig',['+short',e.BRIDGE_DOMAIN,'A'],{encoding:'utf8'});
  if (!dns.stdout.split(/\s+/).includes(e.PBX_PUBLIC_IPV4)) throw new Error('DNS bridge не указывает на PBX');
  const mango = e.PBX_DOMAIN === 'mangosip.ru' || e.PBX_DOMAIN.endsWith('.mangosip.ru');
  const ips = spawnSync('dig',['+short',e.PBX_DOMAIN,'A'],{encoding:'utf8'}).stdout.trim().split(/\s+/).filter(x=>/^\d+\.\d+\.\d+\.\d+$/.test(x));
  if (!ips.length) throw new Error('Нет SIP DNS A');
  const sipSources = mango ? ['81.88.86.0/24'] : ips;
  const mediaSources = mango ? ['81.88.86.0/24','81.88.88.0/24'] : ips;
  const vals = {EXT:e.PBX_EXTENSION,SIP_PASSWORD:e.PBX_SIP_PASSWORD,PBX_DOMAIN:e.PBX_DOMAIN,PBX_PORT:process.env.MVP_SIP_PORT || e.PBX_SIP_PORT || '5060',EXPIRATION:e.PBX_REGISTRATION_EXPIRATION||'180',PBX_IP:sipSources.join(','),PUBLIC_IP:e.PBX_PUBLIC_IPV4,ARI_USER:e.ARI_USER,ARI_PASSWORD:e.ARI_PASSWORD,BRIDGE_DOMAIN:e.BRIDGE_DOMAIN,ALLOW_LINES:e.BRIDGE_ALLOW.split(',').map(x=>`        allow ${x.trim()};`).join('\n')+'\n        allow 127.0.0.1;'};
  mkdirSync(resolve(output,'asterisk'),{recursive:true,mode:0o700});
  function render(source,target) {
    let s=readFileSync(source,'utf8');
    for(const [k,v] of Object.entries(vals)) s=s.replaceAll(`@@${k}@@`,v);
    if (s.includes('@@')) throw new Error(`Не заполнен шаблон ${source}`);
    write(target,s);
  }
  for(const f of ['pjsip','extensions','ari','http','manager','rtp','logger','cdr']) render(`pbx-server/asterisk/${f}.conf`,`asterisk/${f}.conf`);
  render('pbx-server/nginx-pbx.conf','gpt-voice-pbx');
  const d={ARI_USER:e.ARI_USER,ARI_PASSWORD:e.ARI_PASSWORD,BRIDGE_TOKEN:e.BRIDGE_TOKEN,CALLER_ID:e.PBX_CALLER_ID||e.PBX_EXTENSION,ALLOWED_NUMBERS:'none',MAX_CALLS:'1',DIAL_PREFIX:e.DIAL_PREFIX||'7',RECORD_CALLS:'off',RING_TIMEOUT:e.RING_TIMEOUT||'45'};
  write('dialer.env',Object.entries(d).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n');
  write('metadata.json',JSON.stringify({domain:e.BRIDGE_DOMAIN,email:e.ADMIN_EMAIL,sipSources,mediaSources}));
  for(const f of ['dialer.py','requirements.txt','sounds','gpt-voice-dialer.service']) cpSync(`pbx-server/${f}`,resolve(output,f),{recursive:true});
}
console.log(`Подготовлен ${mode}; секреты разделены; PSTN выключен до self-test`);

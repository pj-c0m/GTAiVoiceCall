// Установка выделенных MVP1-хостов с inventory, backup и раздельными credentials.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [mode,config,key] = process.argv.slice(2);
if(!['model','pbx'].includes(mode)||!config) throw new Error('model|pbx CONFIG [SSH_KEY]');
const e=parseEnv(readFileSync(config,'utf8'));
const authority=mode==='model'?['MODEL_SERVER_DEDICATED']:['PBX_SERVER_DEDICATED','PBX_ALLOW_ASTERISK_CONFIG_REPLACEMENT','PBX_ALLOW_FIREWALL_CONFIGURATION'];
for(const k of authority) if(e[k]!=='yes') throw new Error(`Нет разрешения ${k}`);
const host=e[mode==='model'?'MODEL_SSH':'PBX_SSH'];
if(!host||!/^[a-zA-Z0-9_.@:-]+$/.test(host)) throw new Error('Некорректный SSH host');
const stage=mkdtempSync(join(tmpdir(),'gtaivc-deploy-'));
function run(cmd,args,input){
 const r=spawnSync(cmd,args,{encoding:'utf8',input,maxBuffer:20*1024*1024});
 // Remote installers пишут подробный вывод в закрытые server-side логи.
 if(r.status!==0) throw new Error(`${cmd}: deployment остановлен, exit=${r.status}; проверьте server-side install log`);
 return r.stdout;
}
const sshArgs=['-o','BatchMode=yes',...(key?['-i',resolve(key)]:[]),host];
const remote=(s)=>run('ssh',[...sshArgs,'bash','-s'],s);
try {
 run(process.execPath,['scripts/prepare-deploy.mjs',resolve(config),stage,mode]);
 // Snapshot выполняется до первого изменения сервера, повторные запуски сохраняют новый.
 remote(`set -euo pipefail
umask 077
backup=/root/gtaivc-rollback-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$backup"
dpkg-query -W > "$backup/packages.txt"
systemctl list-unit-files > "$backup/units.txt"
ss -lntup > "$backup/ports.txt"
paths=()
for p in /etc/systemd/system /etc/ssh /etc/ufw /etc/zabbix /etc/asterisk /etc/nginx /etc/gpt-voice /srv/gpt-voice /srv/gpt-voice-dialer; do [ ! -e "$p" ] || paths+=("$p"); done
tar -czf "$backup/configs.tar.gz" "\${paths[@]}" 2>/dev/null
rm -rf /root/gtaivc-stage
mkdir -p /root/gtaivc-stage
`);
 // Только whitelist-файлы, собранные prepare-deploy; нет rsync всего workspace/--delete.
 const shellQuote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 run('rsync',['-az','-e',['ssh','-o','BatchMode=yes',...(key?['-i',resolve(key)]:[])].map(shellQuote).join(' '),stage+'/',host+':/root/gtaivc-stage/']);
 if(mode==='model') remote(`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nodejs npm > /root/gtaivc-install-model.log 2>&1
node -e 'process.exit(+process.versions.node.split(".")[0]>=22?0:1)'
id gptvoice >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /srv/gpt-voice gptvoice
mkdir -p /srv/gpt-voice/logs
install -d -m 700 -o gptvoice -g gptvoice /srv/gpt-voice/data
cp -a /root/gtaivc-stage/. /srv/gpt-voice/
cd /srv/gpt-voice
npm ci --omit=dev --silent > /root/gtaivc-install-model-npm.log 2>&1
chmod 600 .env
chown -R gptvoice:gptvoice /srv/gpt-voice
cp model-server/gpt-voice-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gpt-voice-web >/dev/null 2>&1
systemctl restart gpt-voice-web
systemctl is-active --quiet gpt-voice-web
`);
 else remote(readFileSync('pbx-server/install-mvp1.sh','utf8'));
 console.log(`${mode}: deployment выполнен; acceptance проверяется отдельно`);
} finally {
 rmSync(stage,{recursive:true,force:true});
 // Удаление закрытого staging после переноса не затрагивает backup.
 try { remote('rm -rf /root/gtaivc-stage\n'); } catch {}
}

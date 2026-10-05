// Публикация GUI: существующие credentials остаются на своих серверах.
import {readFileSync,writeFileSync,chmodSync,cpSync,mkdtempSync,rmSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const [configPath,passwordPath,keyPath]=process.argv.slice(2);
if(!configPath||!passwordPath||!keyPath)throw Error('Нужны CONFIG GUIPASS SSH_KEY');
const config=parseEnv(readFileSync(configPath,'utf8'));
const model=config.MODEL_SSH,pbx=config.PBX_SSH,domain=config.BRIDGE_DOMAIN;
for(const host of [model,pbx])if(!/^root@[\d.]+$/.test(host))throw Error('Требуется проверенный root@IPv4');
if(!/^[a-zA-Z0-9.-]+$/.test(domain))throw Error('Некорректный домен');
const modelIp=model.split('@')[1];
const raw=readFileSync(passwordPath,'utf8').trim();
const password=raw.startsWith('GUI_PASSWORD=')?parseEnv(raw).GUI_PASSWORD:raw;
if(!password||/[\r\n\0]/.test(password))throw Error('guipass.env должен содержать один пароль');
chmodSync(passwordPath,0o600);
function run(command,args,input){const r=spawnSync(command,args,{input,encoding:'utf8',maxBuffer:12*1024*1024});if(r.status!==0)throw Error(`${command}: exit=${r.status}; ${r.stderr?.replace(/Authorization:.*/g,'Authorization: [hidden]').slice(0,1200)}`);return r.stdout;}
const sshArgs=['-i',resolve(keyPath),'-o','BatchMode=yes','-o','ConnectTimeout=15'];
const remote=(host,script)=>run('ssh',[...sshArgs,host,'bash','-s'],script);
const hash=run('openssl',['passwd','-6','-stdin'],password+'\n').trim();
const sha=run('git',['rev-parse','HEAD']).trim();
const stage=mkdtempSync(join(tmpdir(),'gtaivc-gui-'));chmodSync(stage,0o700);
const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z';
const backup='/root/gtaivc-gui-rollback-'+stamp;
try{
 // Проверяем отсутствие активного разговора до обновления.
 const status=JSON.parse(remote(model,'curl -fsS http://127.0.0.1:3000/api/pbx/status\n'));
 if(status.calls?.length||status.availability?.busy)throw Error('Есть активный/неосвобождённый звонок');
 for(const host of [model,pbx]){
  remote(host,`set -euo pipefail\numask 077\nmkdir -p ${backup}\nsystemctl list-unit-files > ${backup}/units.txt\nss -lntup > ${backup}/ports.txt\npaths=()\nfor p in /srv/gpt-voice /etc/systemd/system/gpt-voice-web.service /etc/systemd/system/gpt-voice-gui-tunnel.service /etc/nginx /etc/gpt-voice /etc/ssh/sshd_config /etc/ssh/sshd_config.d /var/lib/gtaivc-gui-tunnel; do [ ! -e "$p" ] || paths+=("$p"); done\ntar -czf ${backup}/configs.tar.gz "\${paths[@]}" 2>/dev/null\n`);
 }
 console.log('Inventory/rollback сохранены:',backup);
 for(const f of ['server.mjs','package.json','package-lock.json','lib','public','profiles','model-server'])cpSync(f,join(stage,f),{recursive:true});
 cpSync('scripts/restore-job-state.mjs',join(stage,'restore-job-state.mjs'));
 writeFileSync(join(stage,'DEPLOYED_SHA'),sha+'\n');
 const transport=['ssh',...sshArgs].map(s=>"'"+s.replaceAll("'","'\\''")+"'").join(' ');
 run('rsync',['-az','-e',transport,stage+'/',model+':/root/gtaivc-gui-stage/']);
 remote(model,`set -euo pipefail\nsystemctl stop gpt-voice-web\nif [ -d /srv/gpt-voice/data ]; then tar -czf ${backup}/data-stopped.tar.gz -C /srv/gpt-voice data; fi\ninstall -d -m 700 -o gptvoice -g gptvoice /srv/gpt-voice/data\ncp -a /root/gtaivc-gui-stage/. /srv/gpt-voice/\nchown root:gptvoice /srv/gpt-voice\nchmod 750 /srv/gpt-voice\nmkdir -p /srv/gpt-voice/scripts\nmv /srv/gpt-voice/restore-job-state.mjs /srv/gpt-voice/scripts/\nchown -R gptvoice:gptvoice /srv/gpt-voice/{lib,public,profiles,model-server,scripts,data}\ncd /srv/gpt-voice\nnpm ci --omit=dev --silent > ${backup}/npm-install.log 2>&1\npython3 - <<'PY'\nfrom pathlib import Path\np=Path('/srv/gpt-voice/.env')\ns=p.read_text().splitlines()\ns=[x for x in s if not x.startswith('ALLOWED_ORIGINS=')]\ns.append('ALLOWED_ORIGINS="https://${domain},http://localhost:3000,http://127.0.0.1:3000"')\np.write_text('\\n'.join(s)+'\\n');p.chmod(0o600)\nPY\ncp model-server/gpt-voice-web.service /etc/systemd/system/\nsystemctl daemon-reload\nsystemctl start gpt-voice-web\nsystemctl is-active --quiet gpt-voice-web\nrm -rf /root/gtaivc-gui-stage\n`);
 remote(pbx,`set -euo pipefail\ninstall -d -m 750 -o root -g gptvoice /etc/gpt-voice/gui-tunnel\nif [ ! -f /etc/gpt-voice/gui-tunnel/id_ed25519 ]; then ssh-keygen -q -t ed25519 -N '' -C gtaivc-gui-tunnel -f /etc/gpt-voice/gui-tunnel/id_ed25519; fi\nchown gptvoice:gptvoice /etc/gpt-voice/gui-tunnel/id_ed25519*\nchmod 600 /etc/gpt-voice/gui-tunnel/id_ed25519\n`);
 const publicKey=remote(pbx,'cat /etc/gpt-voice/gui-tunnel/id_ed25519.pub\n').trim();
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+ /.test(publicKey))throw Error('Неожиданный public key');
 const hostKey=remote(model,'ssh-keygen -y -f /etc/ssh/ssh_host_ed25519_key\n').trim();
 remote(model,`set -euo pipefail\nid guitunnel >/dev/null 2>&1 || useradd -r -m -d /var/lib/gtaivc-gui-tunnel -s /bin/sh guitunnel\ninstall -d -m 700 -o guitunnel -g guitunnel /var/lib/gtaivc-gui-tunnel/.ssh\ncat > /var/lib/gtaivc-gui-tunnel/.ssh/authorized_keys <<'KEY'\nfrom="${pbx.split('@')[1]}",restrict,port-forwarding,command="/bin/false",permitopen="127.0.0.1:3000" ${publicKey}\nKEY\nchown guitunnel:guitunnel /var/lib/gtaivc-gui-tunnel/.ssh/authorized_keys\nchmod 600 /var/lib/gtaivc-gui-tunnel/.ssh/authorized_keys\ncat > /etc/ssh/sshd_config.d/90-gtaivc-gui-tunnel.conf <<'SSHCONF'\nMatch User guitunnel\n    AllowTcpForwarding local\n    PermitOpen 127.0.0.1:3000\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    PermitTTY no\n    AllowAgentForwarding no\n    X11Forwarding no\n    ForceCommand /bin/false\nMatch all\nSSHCONF\nsshd -t\nsystemctl reload ssh\n`);
 const unit=readFileSync('pbx-server/gpt-voice-gui-tunnel.service','utf8').replace('147.45.132.111',modelIp);
 const location=readFileSync('pbx-server/nginx-gui-location.conf','utf8');
 // Передаётся только hash GUI-пароля; cleartext и OpenAI key на PBX не попадают.
 remote(pbx,`set -euo pipefail\numask 077\ncat > /etc/gpt-voice/gui.htpasswd <<'HASH'\nadmin:${hash}\nHASH\nchown root:www-data /etc/gpt-voice/gui.htpasswd\nchmod 640 /etc/gpt-voice/gui.htpasswd\ncat > /etc/gpt-voice/gui-tunnel/known_hosts <<'HOSTKEY'\n${modelIp} ${hostKey}\nHOSTKEY\nchmod 644 /etc/gpt-voice/gui-tunnel/known_hosts\ncat > /etc/systemd/system/gpt-voice-gui-tunnel.service <<'UNIT'\n${unit}\nUNIT\ncat > /etc/nginx/gtaivc-gui-location.conf <<'LOCATION'\n${location}\nLOCATION\npython3 - <<'PY'\nfrom pathlib import Path\np=Path('/etc/nginx/sites-available/gpt-voice-pbx')\ns=p.read_text();old='location / { return 404; }';new='include /etc/nginx/gtaivc-gui-location.conf;'\nif old not in s and new not in s: raise RuntimeError('Неизвестный nginx config; остановлено')\np.write_text(s.replace(old,new))\nPY\nnginx -t\nsystemctl daemon-reload\nsystemctl enable --now gpt-voice-gui-tunnel\nsystemctl restart gpt-voice-gui-tunnel\nsystemctl reload nginx\nfor n in $(seq 1 20); do if curl -fsS http://127.0.0.1:13000/api/pbx/status >/dev/null; then break; fi; sleep 1; done\ncurl -fsS http://127.0.0.1:13000/api/pbx/status >/dev/null\nsystemctl is-active --quiet gpt-voice-gui-tunnel nginx\n`);
 console.log('GUI опубликован:',`https://${domain}/?profile=example-call`,'SHA:',sha);
}finally{rmSync(stage,{recursive:true,force:true});}

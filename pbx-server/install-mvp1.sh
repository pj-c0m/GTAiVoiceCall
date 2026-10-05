#!/usr/bin/env bash
# Запускается deploy-mvp1.mjs только после backup и безопасной проекции env.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq asterisk python3-venv nginx certbot python3-certbot-nginx ufw dnsutils curl > /root/gtaivc-install-pbx.log 2>&1
systemctl stop asterisk
id gptvoice >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /srv/gpt-voice-dialer gptvoice
mkdir -p /etc/gpt-voice /srv/gpt-voice-dialer/sounds
cp /root/gtaivc-stage/asterisk/*.conf /etc/asterisk/
cp /root/gtaivc-stage/dialer.env /etc/gpt-voice/dialer.env
cp /root/gtaivc-stage/dialer.py /root/gtaivc-stage/requirements.txt /srv/gpt-voice-dialer/
cp /root/gtaivc-stage/sounds/*.wav /srv/gpt-voice-dialer/sounds/
cp /root/gtaivc-stage/gpt-voice-dialer.service /etc/systemd/system/
chown root:gptvoice /etc/gpt-voice/dialer.env
chmod 640 /etc/gpt-voice/dialer.env
chown -R gptvoice:gptvoice /srv/gpt-voice-dialer
chown asterisk:asterisk /etc/asterisk/*.conf
chmod 640 /etc/asterisk/*.conf
install -d -o asterisk -g asterisk -m 750 /var/spool/asterisk/recording
install -d -o gptvoice -g gptvoice -m 750 /var/log/gpt-voice
[ -x /srv/gpt-voice-dialer/.venv/bin/python ] || runuser -u gptvoice -- python3 -m venv /srv/gpt-voice-dialer/.venv
runuser -u gptvoice -- /srv/gpt-voice-dialer/.venv/bin/pip install -q -r /srv/gpt-voice-dialer/requirements.txt > /root/gtaivc-install-pbx-pip.log 2>&1
python3 - <<'PY'
import json, pathlib, subprocess
m=json.loads(pathlib.Path('/root/gtaivc-stage/metadata.json').read_text())
def run(*args): subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for port in ['OpenSSH','80/tcp','443/tcp','10050/tcp']: run('ufw','allow',port)
# 10050 сохраняет исходную доступность уже установленного Zabbix.
for ip in m['sipSources']: run('ufw','allow','from',ip,'to','any','port','5060','proto','udp')
for ip in m['mediaSources']: run('ufw','allow','from',ip,'to','any','port','10000:10200','proto','udp')
run('ufw','--force','enable')
if not pathlib.Path('/etc/letsencrypt/live/'+m['domain']+'/fullchain.pem').exists():
    p=pathlib.Path('/etc/nginx/sites-available/gpt-voice-pbx-http')
    p.write_text('server { listen 80; server_name '+m['domain']+'; location / { return 404; } }\n')
    link=pathlib.Path('/etc/nginx/sites-enabled/gpt-voice-pbx-http')
    if not link.exists(): link.symlink_to(p)
    run('nginx','-t'); run('systemctl','reload','nginx')
    run('certbot','certonly','--nginx','-d',m['domain'],'--non-interactive','--agree-tos','-m',m['email'])
    link.unlink()
pathlib.Path('/etc/nginx/sites-available/gpt-voice-pbx').write_bytes(pathlib.Path('/root/gtaivc-stage/gpt-voice-pbx').read_bytes())
link=pathlib.Path('/etc/nginx/sites-enabled/gpt-voice-pbx')
if not link.exists(): link.symlink_to('/etc/nginx/sites-available/gpt-voice-pbx')
run('nginx','-t'); run('systemctl','reload','nginx')
PY
cat > /etc/logrotate.d/gtaivc <<'ROT'
/var/log/gpt-voice/calls.jsonl {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    copytruncate
}
ROT
systemctl daemon-reload
systemctl enable --now asterisk gpt-voice-dialer >/dev/null 2>&1
systemctl restart gpt-voice-dialer
systemctl is-active --quiet asterisk gpt-voice-dialer

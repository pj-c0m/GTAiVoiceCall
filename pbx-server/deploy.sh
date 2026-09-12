#!/usr/bin/env bash
# Развёртывание сервера телефонии (контур РФ): Asterisk, диалер, nginx с TLS, файрвол.
# Запускать там, где лежит проект и заполненный .env:   bash pbx-server/deploy.sh
# Скрипт идемпотентный: повторный запуск обновляет конфиги и перезапускает сервисы.
# Настройки самой АТС не меняет — Asterisk только регистрируется на ней внутренним номером.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "нет .env — скопируйте .env.example в .env и заполните"; exit 1; }
set -a; source .env; set +a
for v in PBX_SSH PBX_DOMAIN PBX_EXTENSION PBX_SIP_PASSWORD BRIDGE_DOMAIN BRIDGE_TOKEN ADMIN_EMAIL; do
  [ -n "${!v:-}" ] || { echo "в .env не заполнено $v (см. .env.example)"; exit 1; }
done
HOST="$PBX_SSH"

# Одноразовые значения дописываем в .env, чтобы повторный деплой ничего не ломал
ensure() { grep -qE "^$1=" .env || printf '%s=%s\n' "$1" "$2" >> .env; }
ensure ARI_USER dialer
ensure ARI_PASSWORD "$(openssl rand -hex 20)"
ensure ALLOWED_NUMBERS none
ensure MAX_CALLS 2
ensure DIAL_PREFIX 7
ensure RECORD_CALLS off
ensure FIREWALL auto
ensure BRIDGE_URL "wss://$BRIDGE_DOMAIN/pbx/bridge"
set -a; source .env; set +a
if [ -z "${BRIDGE_ALLOW:-}" ]; then
  BRIDGE_ALLOW="$(curl -4 -s --max-time 5 https://ifconfig.me || true)"
  echo "! BRIDGE_ALLOW не задан — беру адрес этой машины ($BRIDGE_ALLOW). Если сервер модели другой, впишите его адрес в .env"
  ensure BRIDGE_ALLOW "$BRIDGE_ALLOW"
fi

PBX_IP="$(dig +short "$PBX_DOMAIN" A | grep -E '^[0-9.]+$' | head -1)"
[ -n "$PBX_IP" ] || { echo "не удалось разрешить $PBX_DOMAIN в IP"; exit 1; }
PUBLIC_IP="$(ssh "$HOST" "curl -4 -s --max-time 5 https://ifconfig.me")"
[ -n "$PUBLIC_IP" ] || { echo "сервер телефонии не отвечает по SSH ($HOST) или не видит интернет"; exit 1; }
echo "АТС: $PBX_DOMAIN → $PBX_IP · сервер телефонии: $PUBLIC_IP · добавочный: $PBX_EXTENSION · мост: https://$BRIDGE_DOMAIN/pbx/ (доступ с $BRIDGE_ALLOW)"

# ── Рендер конфигов: подстановка @@ПЕРЕМЕННЫХ@@ (без sed, чтобы спецсимволы в паролях не ломали) ──
TMP="$(mktemp -d)"; chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT
PBX_IP="$PBX_IP" PUBLIC_IP="$PUBLIC_IP" python3 - "$TMP" <<'PY'
import os, pathlib, sys
out = pathlib.Path(sys.argv[1]); (out / "asterisk").mkdir()
vals = {
  "EXT": os.environ["PBX_EXTENSION"], "SIP_PASSWORD": os.environ["PBX_SIP_PASSWORD"],
  "PBX_DOMAIN": os.environ["PBX_DOMAIN"], "PBX_IP": os.environ["PBX_IP"], "PUBLIC_IP": os.environ["PUBLIC_IP"],
  "ARI_USER": os.environ["ARI_USER"], "ARI_PASSWORD": os.environ["ARI_PASSWORD"], "BRIDGE_DOMAIN": os.environ["BRIDGE_DOMAIN"],
}
allow = "\n".join(f"        allow {a.strip()};" for a in os.environ.get("BRIDGE_ALLOW", "").split(",") if a.strip())
vals["ALLOW_LINES"] = allow + "\n        allow 127.0.0.1;"
def render(src, dst):
    text = pathlib.Path(src).read_text()
    for k, v in vals.items(): text = text.replace(f"@@{k}@@", v)
    assert "@@" not in text, f"незаполненная переменная в {src}"
    p = out / dst; p.write_text(text); p.chmod(0o600)
for f in ("pjsip", "extensions", "ari", "http", "manager", "rtp", "logger", "cdr"):
    render(f"pbx-server/asterisk/{f}.conf", f"asterisk/{f}.conf")
render("pbx-server/nginx-pbx.conf", "gpt-voice-pbx")
env = "\n".join([
  f"ARI_USER={vals['ARI_USER']}", f"ARI_PASSWORD={vals['ARI_PASSWORD']}",
  f"BRIDGE_TOKEN={os.environ['BRIDGE_TOKEN']}", f"CALLER_ID={os.environ.get('PBX_CALLER_ID', vals['EXT'])}",
  f"ALLOWED_NUMBERS={os.environ.get('ALLOWED_NUMBERS', 'none')}", f"MAX_CALLS={os.environ.get('MAX_CALLS', '2')}",
  f"DIAL_PREFIX={os.environ.get('DIAL_PREFIX', '7')}", f"RECORD_CALLS={os.environ.get('RECORD_CALLS', 'off')}", ""])
(out / "dialer.env").write_text(env); (out / "dialer.env").chmod(0o600)
print("конфиги собраны")
PY

# ── Копируем ────────────────────────────────────────────────────────────────
ssh "$HOST" "mkdir -p /etc/gpt-voice /srv/gpt-voice-dialer/sounds /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/asterisk && \
  { [ -d /etc/asterisk.bak-orig ] || cp -a /etc/asterisk /etc/asterisk.bak-orig 2>/dev/null || true; }"
scp -q "$TMP"/asterisk/*.conf "$HOST:/etc/asterisk/"
scp -q "$TMP/dialer.env" "$HOST:/etc/gpt-voice/dialer.env"
scp -q "$TMP/gpt-voice-pbx" "$HOST:/etc/nginx/sites-available/gpt-voice-pbx"
scp -q pbx-server/dialer.py pbx-server/requirements.txt "$HOST:/srv/gpt-voice-dialer/"
scp -q pbx-server/gpt-voice-dialer.service "$HOST:/etc/systemd/system/"
if ls pbx-server/sounds/*.wav >/dev/null 2>&1; then scp -q pbx-server/sounds/*.wav "$HOST:/srv/gpt-voice-dialer/sounds/"; fi

# ── Настраиваем сервер ──────────────────────────────────────────────────────
ssh "$HOST" PBX_IP="$PBX_IP" BRIDGE_DOMAIN="$BRIDGE_DOMAIN" ADMIN_EMAIL="$ADMIN_EMAIL" FIREWALL="$FIREWALL" PUBLIC_IP="$PUBLIC_IP" bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
need=""
for p in asterisk python3-venv nginx certbot python3-certbot-nginx ufw dnsutils curl; do dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"; done
if [ -n "$need" ]; then echo "ставлю пакеты:$need"; apt-get update -qq; apt-get install -y -qq $need >/dev/null; fi

id gptvoice >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /srv/gpt-voice-dialer gptvoice
chown root:gptvoice /etc/gpt-voice/dialer.env; chmod 640 /etc/gpt-voice/dialer.env
chown -R gptvoice:gptvoice /srv/gpt-voice-dialer
chown asterisk:asterisk /etc/asterisk/*.conf; chmod 640 /etc/asterisk/*.conf
install -d -o asterisk -g asterisk -m 750 /var/spool/asterisk/recording
install -d -o gptvoice -g gptvoice -m 750 /var/log/gpt-voice
cat > /etc/logrotate.d/gpt-voice <<'ROT'
/var/log/gpt-voice/calls.jsonl {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    copytruncate
}
/var/log/asterisk/full {
    daily
    rotate 14
    compress
    missingok
    notifempty
    postrotate
        /usr/sbin/asterisk -rx 'logger reload' >/dev/null 2>&1 || true
    endscript
}
ROT
[ -x /srv/gpt-voice-dialer/.venv/bin/python ] || sudo -u gptvoice python3 -m venv /srv/gpt-voice-dialer/.venv
sudo -u gptvoice /srv/gpt-voice-dialer/.venv/bin/pip install -q -r /srv/gpt-voice-dialer/requirements.txt

# Файрвол: SIP и RTP — только с адреса АТС; наружу только SSH и HTTPS моста
if [ "$FIREWALL" = "auto" ]; then
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow from "$PBX_IP" to any port 5060 proto udp comment 'PBX SIP' >/dev/null
  ufw allow from "$PBX_IP" to any port 10000:10200 proto udp comment 'PBX RTP' >/dev/null
  ufw status | grep -q "Status: active" || { echo "включаю ufw (входящие по умолчанию закрыты, SSH разрешён)"; ufw --force enable >/dev/null; }
  broad=$(ufw status | grep -E "(5060|6060|10000)" | grep -iE "anywhere" || true)
  [ -z "$broad" ] || echo "! в файрволе есть широкие правила для SIP/RTP, уберите их вручную (ufw delete …):"$'\n'"$broad"
else
  echo "FIREWALL=$FIREWALL — файрвол не трогаю; откройте 5060/udp и 10000-10200/udp только для $PBX_IP"
fi

# nginx + сертификат для моста
if [ ! -f "/etc/letsencrypt/live/$BRIDGE_DOMAIN/fullchain.pem" ]; then
  printf 'server { listen 80; server_name %s; location / { return 404; } }\n' "$BRIDGE_DOMAIN" > /etc/nginx/sites-available/gpt-voice-pbx-http
  ln -sf /etc/nginx/sites-available/gpt-voice-pbx-http /etc/nginx/sites-enabled/gpt-voice-pbx-http
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  certbot certonly --nginx -d "$BRIDGE_DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" >/dev/null \
    || { echo "certbot не получил сертификат: проверьте, что A-запись $BRIDGE_DOMAIN указывает на $PUBLIC_IP и порт 80 открыт"; exit 1; }
  rm -f /etc/nginx/sites-enabled/gpt-voice-pbx-http
fi
ln -sf /etc/nginx/sites-available/gpt-voice-pbx /etc/nginx/sites-enabled/gpt-voice-pbx
nginx -t >/dev/null 2>&1 || { nginx -t; exit 1; }
systemctl reload nginx

systemctl enable --now asterisk >/dev/null 2>&1
sleep 2; asterisk -rx "core reload" >/dev/null; sleep 4
systemctl daemon-reload; systemctl enable --now gpt-voice-dialer >/dev/null 2>&1; systemctl restart gpt-voice-dialer; sleep 2

echo "── регистрация в АТС:"; asterisk -rx "pjsip show registrations" | grep -E "sip:|Registered|Rejected|Unregistered" | head -3
echo "── модули:"; asterisk -rx "module show like chan_rtp" | grep -c "Running" | sed 's/^/chan_rtp running: /'
echo "── диалер:"; systemctl is-active gpt-voice-dialer; journalctl -u gpt-voice-dialer -n 2 --no-pager -o cat
echo "── файрвол:"; ufw status 2>/dev/null | grep -E "5060|10000" || true
REMOTE
echo "готово"

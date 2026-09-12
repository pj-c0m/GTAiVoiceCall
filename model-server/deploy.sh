#!/usr/bin/env bash
# Сервер модели (вне контура РФ): Node 20+, проект в /srv/gpt-voice, сервис gpt-voice-web.
# Запускать с машины, где лежит проект и заполненный .env:   bash model-server/deploy.sh
# Интерфейс оператора наружу не публикуется — доступ через SSH-туннель:
#   ssh -L 3000:127.0.0.1:3000 <MODEL_SSH>   →   http://localhost:3000
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "нет .env — скопируйте .env.example в .env и заполните"; exit 1; }
set -a; source .env; set +a
: "${MODEL_SSH:?в .env нет MODEL_SSH — SSH-адрес сервера модели (user@host или alias)}"
: "${OPENAI_API_KEY:?в .env нет OPENAI_API_KEY}"
HOST="$MODEL_SSH"

ssh "$HOST" "mkdir -p /srv/gpt-voice/logs"
rsync -az --delete --exclude node_modules --exclude logs --exclude .git --exclude .playwright-mcp ./ "$HOST:/srv/gpt-voice/"
ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  echo "ставлю Node.js 22"; curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null; apt-get install -y -qq nodejs >/dev/null
fi
id gptvoice >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /srv/gpt-voice gptvoice
cd /srv/gpt-voice && npm install --omit=dev --silent
chmod 600 .env; chown -R gptvoice:gptvoice /srv/gpt-voice
cp model-server/gpt-voice-web.service /etc/systemd/system/
systemctl daemon-reload; systemctl enable --now gpt-voice-web >/dev/null 2>&1; systemctl restart gpt-voice-web; sleep 3
echo "── сервис:"; systemctl is-active gpt-voice-web; tail -n 4 /srv/gpt-voice/logs/brain.log 2>/dev/null | cut -c1-160
echo "── публичный адрес этого сервера (для BRIDGE_ALLOW): $(curl -4 -s --max-time 5 https://ifconfig.me)"
REMOTE
echo "готово. Интерфейс: ssh -L 3000:127.0.0.1:3000 $HOST → http://localhost:3000"

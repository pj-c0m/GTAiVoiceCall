#!/usr/bin/env bash
# Безопасный deployment: dotenv разбирается Node, на модель копируется только проекция.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/deploy-mvp1.mjs model "${1:-.env}" "${2:-}"

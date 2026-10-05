#!/usr/bin/env bash
# Deployment PBX без OpenAI key; реальные звонки остаются выключены до self-test.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/deploy-mvp1.mjs pbx "${1:-.env}" "${2:-}"

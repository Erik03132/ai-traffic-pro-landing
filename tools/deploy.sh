#!/usr/bin/env bash
#
# Деплой статики на Timeweb Cloud App Platform.
#
# Зачем: у приложения нет вебхука на пуш (репозиторий подключён по URL, а не
# через OAuth), поэтому `git push` прод не обновляет — только резервные
# GitHub Pages / Cloudflare Pages. Этот скрипт запускает сборку на Timeweb
# и, с `--wait`, ждёт её окончания, чтобы «запустил деплой» не означало
# «надеюсь, доехало» (SA-1: Fixed ≠ Verified).
#
# Токен: переменная TIMEWEB_TOKEN или строка TIMEWEB_TOKEN=... в .env проекта.
# Токен не печатается и не логируется.
#
# Примеры:
#   bash tools/deploy.sh --dry-run
#   bash tools/deploy.sh --wait
#   bash tools/deploy.sh --commit 2ed820950f1815da2ca80db20d6dc52d5605119e --wait --timeout 900
#
# Коды выхода: 0 — деплой успешен, 1 — сборка упала, 2 — таймаут ожидания,
#              3 — ошибка API/токена, 4 — неверные аргументы.

set -euo pipefail

APP_ID="294905"
COMMIT=""
WAIT=0
TIMEOUT=600
DRY_RUN=0
POLL=15
API="https://timeweb.cloud/api/v1"

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_ID="${2:?--app требует id}"; shift 2 ;;
    --commit) COMMIT="${2:?--commit требует sha}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout требует секунд}"; shift 2 ;;
    --poll) POLL="${2:?--poll требует секунд}"; shift 2 ;;
    --wait) WAIT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "неизвестный флаг: $1 (см. --help)" >&2; exit 4 ;;
  esac
done

cd "$(dirname "$0")/.."

if [ -z "$COMMIT" ]; then
  COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
fi
if ! printf '%s' "$COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "нужен полный sha (40 hex), получил: '$COMMIT'" >&2
  exit 4
fi

if [ -z "${TIMEWEB_TOKEN:-}" ] && [ -f .env ]; then
  TIMEWEB_TOKEN="$(grep -E '^TIMEWEB_TOKEN=' .env | head -1 | cut -d= -f2- || true)"
fi
if [ -z "${TIMEWEB_TOKEN:-}" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "нет TIMEWEB_TOKEN (env или .env) — токен: https://timeweb.cloud/my/api-keys" >&2
  exit 3
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: деплой не запускается"
  echo "  приложение: $APP_ID"
  echo "  коммит:     $COMMIT ($(git log -1 --format=%s "$COMMIT" 2>/dev/null || echo '?'))"
  echo "  ожидание:   $([ "$WAIT" -eq 1 ] && echo "да, до ${TIMEOUT}s" || echo 'нет')"
  exit 0
fi

json_get() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }

echo "→ запускаю деплой $APP_ID на коммите ${COMMIT:0:7}"
resp="$(curl -sS -w '\n%{http_code}' -X POST "$API/apps/$APP_ID/deploy" \
  -H "Authorization: Bearer $TIMEWEB_TOKEN" -H "Content-Type: application/json" \
  -d "{\"commit_sha\":\"$COMMIT\"}")" || { echo "сеть недоступна" >&2; exit 3; }
code="$(printf '%s' "$resp" | tail -1)"
body="$(printf '%s' "$resp" | sed '$d')"
if [ "$code" != "201" ] && [ "$code" != "200" ]; then
  echo "API отказал (HTTP $code): $(printf '%s' "$body" | head -c 300)" >&2
  exit 3
fi
DEPLOY_ID="$(printf '%s' "$body" | json_get "d['deploy']['id']")"
STATUS="$(printf '%s' "$body" | json_get "d['deploy']['status']")"
echo "  deploy id: $DEPLOY_ID · статус: $STATUS"

[ "$WAIT" -eq 1 ] || exit 0

started=$(date +%s)
last=""
while :; do
  sleep "$POLL"
  resp="$(curl -sS "$API/apps/$APP_ID/deploys?limit=1" -H "Authorization: Bearer $TIMEWEB_TOKEN" || true)"
  status="$(printf '%s' "$resp" | json_get "d['deploys'][0]['status']" 2>/dev/null || echo '?')"
  if [ "$status" != "$last" ]; then
    printf '  %s: %s\n' "$(date +%H:%M:%S)" "$status"
    last="$status"
  fi
  case "$status" in
    success) echo "✅ деплой завершён"; exit 0 ;;
    failed|canceled|cancelled) echo "❌ сборка не прошла: $status" >&2; exit 1 ;;
  esac
  if [ $(( $(date +%s) - started )) -ge "$TIMEOUT" ]; then
    echo "⏱ таймаут ${TIMEOUT}s, последний статус: $status" >&2
    exit 2
  fi
done

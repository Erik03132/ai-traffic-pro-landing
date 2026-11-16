#!/usr/bin/env bash
#
# Читает лог вопросов из виджета: «вопрос → ответ» за день.
#
# Зачем: эндпоинт отдаёт текст, но каждый раз набирать curl с токеном —
# это то, из-за чего логи не читают. Токен берётся из .env в корне репозитория
# и никогда не печатается.
#
# Примеры:
#   tools/chat-log.sh                      # сегодня (МСК), читаемым текстом
#   tools/chat-log.sh --day 2026-11-15      # конкретный день
#   tools/chat-log.sh --json --limit 20     # сырой JSON, 20 последних
#   tools/chat-log.sh --url                 # показать адрес запроса и выйти
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${CHAT_API_BASE:-https://ai-traffic-pro-api.erik03132.workers.dev}"
DAY="$(date -v+3H +%F 2>/dev/null || date -d '+3 hours' +%F)"
JSON=0
LIMIT=""

usage() {
  cat <<'TXT'
Читает лог вопросов из виджета.

Флаги:
  --day YYYY-MM-DD  день по Москве (по умолчанию сегодня)
  --limit N         сколько записей (1..200)
  --json            отдать сырой JSON вместо текста
  --url             показать адрес запроса и выйти
  -h, --help        эта справка

Примеры:
  tools/chat-log.sh
  tools/chat-log.sh --day 2026-11-15
  tools/chat-log.sh --json --limit 20
TXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    --day) DAY="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --json) JSON=1; shift ;;
    --url) echo "$API/api/chat/log?format=text&day=$DAY"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Неизвестный флаг: $1 (см. --help)" >&2; exit 2 ;;
  esac
done

if [ -z "${TG_PUBLISH_TOKEN:-}" ]; then
  if [ -f "$ROOT/.env" ]; then
    TG_PUBLISH_TOKEN="$(awk -F= '/^TG_PUBLISH_TOKEN=/{sub(/^[^=]*=/, ""); print; exit}' "$ROOT/.env")"
  fi
fi

if [ -z "${TG_PUBLISH_TOKEN:-}" ]; then
  echo "Нет TG_PUBLISH_TOKEN: задайте в окружении или в $ROOT/.env" >&2
  exit 1
fi

QUERY="limit=${LIMIT:-200}"
if [ "$JSON" -eq 0 ]; then
  QUERY="format=text&day=$DAY&limit=${LIMIT:-200}"
fi

curl -sS -m 30 -f -H "Authorization: Bearer $TG_PUBLISH_TOKEN" "$API/api/chat/log?$QUERY"

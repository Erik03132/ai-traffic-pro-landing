# AI-Traffic PRO — сайт маркетингового агентства

Домен: `https://ai-traffic-pro.ru` · Стек: Astro 5+ (static) + Tailwind 4 · API: Cloudflare Worker (резерв — Node на VPS)

## Что здесь

Сайт собран из UI-макета Stitch и превращён в живой продукт: рабочие кнопки, рабочие
формы, чат-виджет, SEO-разметка и GEO-слой.

```
src/
  data/site.ts        ← ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ: услуги, тексты, FAQ, мета, контакты
  layouts/Base.astro  ← обвязка: мета, canonical, OG, JSON-LD, скрипты
  components/         ← Header, Hero, Services, Approach, Process, Method,
                         ContactSection, LeadForm, Faq, Footer, ChatWidget
  pages/
    index.astro           главная
    services/[slug].astro шаблон всех страниц услуг (6 основных + CRM)
    privacy.astro         политика конфиденциальности
    consent.astro         согласие на обработку ПДн
  styles/global.css   ← дизайн-токены из Stitch (Manrope / Inter / JetBrains Mono)
server/
  agent-core.js     ← ОБЩАЯ ЛОГИКА API: база знаний, валидация заявки, формат
                      сообщения Telegram. Один источник истины для Worker и VPS
  server.js         ← Node-сервер на VPS (резерв): /api/lead, /api/chat
worker/
  src/index.js      ← Cloudflare Worker (основной API): /api/lead, /api/chat
  wrangler.jsonc    ← биндинги: KV лидов, Workers AI, rate limit, секреты
src/lib/api-post.ts ← POST с резервным адресом: повтор только при сетевой ошибке
docs/CONTENT_SPEC.md  ← спека контента с обоснованиями
docs/adr/            ← архитектурные решения (ADR-001: API на Worker)
```

> **Правило:** тексты живут только в `src/data/site.ts`. В разметке страниц текстов
> нет — всё генерируется из данных. Это убирает расхождения между страницами.

## Команды

```bash
npm install
npm run dev        # Astro dev на :4321, /api проксируется на :3001
npm run build      # сборка в dist/
npm run preview    # предпросмотр собранного сайта
npm run server     # только сервер заявок на :3001
npm run dev:full   # оба сразу
```

## Приём заявок

Сайт — статика, поэтому заявки принимает отдельный API. Основной — Cloudflare
Worker, резервный — Node-сервер на VPS (см. ADR-001):

| Эндпоинт           | Назначение                                       |
| ------------------ | ------------------------------------------------ |
| `POST /api/lead/`  | Заявка с формы → Telegram + резервный JSONL-файл |
| `POST /api/chat/`  | Вопрос из виджета → база знаний, иначе LLM       |
| `GET /api/health/` | Проверка живости (`{"ok":true,"telegram":true}`) |

Telegram настроен: бот `@ai_bureau_new_bot`, заявки приходят в чат владельца.
Если токен недоступен или Telegram вернул ошибку — заявка не теряется: Worker
пишет её в Workers KV (binding `LEADS`) **до** отправки в Telegram, Node-сервер
на VPS — в `server/leads/YYYY-MM-DD.jsonl`, и оба отвечают успехом.

LLM отвечает на вопросы вне базы знаний. На Worker это **Workers AI**
(`@cf/meta/llama-3.1-8b-instruct-fp8-fast`) — внешние провайдеры с российского IP
отдают 403, а из edge-исполнения Cloudflare работают. На Node-сервере (резерв)
провайдер — любой OpenAI-совместимый эндпоинт (`LLM_BASE_URL` + `LLM_MODEL`),
запасной — `LLM_FALLBACK_*`; внешние провайдеры из РФ идут через SOCKS5
(`LLM_PROXY`) — свой клиент `server/socks.js`, без npm-зависимостей. Если LLM
недоступен — виджет отвечает по базе знаний, а не «пустым» сообщением.

Общая логика (база знаний, валидация заявки, формат сообщения Telegram) лежит в
`server/agent-core.js` — это один источник истины для Worker и Node-сервера,
чтобы резерв не отвечал иначе, чем основной путь.

## Деплой

Схема размещения: **статика на GitHub Pages, API на Cloudflare Worker, VPS в резерве**.
Решение зафиксировано в [ADR-001](docs/adr/ADR-001-api-on-cloudflare-worker.md).

| Что                       | Где                                    | Адрес                                                        |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Статика (Astro → `dist/`) | GitHub Pages                           | `https://ai-traffic-pro.ru`                                  |
| API (заявки, чат)         | Cloudflare Worker (основной)           | `https://ai-traffic-pro-api.erik03132.workers.dev`           |
| API (заявки, чат)         | Node-сервер на VPS `217.149.23.113`    | `https://api.ai-traffic-pro.ru` (резерв, другая инфраструктура)|

DNS: A-записи `ai-traffic-pro.ru` и `www.ai-traffic-pro.ru` → `185.199.108.153`
(IP GitHub Pages), `api.ai-traffic-pro.ru` → `217.149.23.113` (резервный API).
TLS-сертификат выпускает GitHub (Let's Encrypt, до 2027-01-04), автообновление —
на стороне GitHub.

Адреса API приходят из окружения сборки, а не из репозитория:

| Переменная                | Где задана                              | Значение                                       |
| ------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `PUBLIC_API_BASE_URL`     | GitHub Actions → variable                | `https://ai-traffic-pro-api.erik03132.workers.dev` |
| `PUBLIC_API_FALLBACK_URL` | GitHub Actions → variable                | `https://api.ai-traffic-pro.ru`                |

**Резерв срабатывает только при сетевой ошибке.** Если Worker недоступен по сети
(троттлинг трафика из РФ, обрыв), запрос уходит на VPS. На 5xx повтора нет:
сервер ответил — значит заявка могла уйти, повтор дал бы клиенту две заявки.
Если не сработало ни то, ни другое, форма показывает ссылку в Telegram с уже
готовым текстом заявки.

Статика собирается в CI: пуш в `main` → `.github/workflows/deploy.yml` → Astro build →
артефакт `dist` → Pages. Адреса API подставляются на этапе сборки через GitHub
Actions variables `PUBLIC_API_BASE_URL` и `PUBLIC_API_FALLBACK_URL`. Пустая
переменная = API на том же домене (локальная сборка, nginx-проксирование).

### Worker (основной API)

Деплой: `npm run worker:deploy` (wrangler, конфиг `worker/wrangler.jsonc`).
Логи в реальном времени: `npm run worker:tail`.

Секреты — только через `wrangler secret put` (в репозитории их нет):

| Секрет             | Назначение                                      |
| ------------------ | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | отправка заявок в чат владельца               |
| `TELEGRAM_CHAT_ID` | чат-владелец                                    |
| `ALLOWED_ORIGINS`  | белый список origin'ов (CORS)                  |

Биндинги (в `wrangler.jsonc`): `LEADS` (Workers KV — бэкап заявок), `AI`
(Workers AI — LLM), `CHAT_LIMITER` и `LEAD_LIMITER` (rate limit, раздельные баки).

> `preview_urls: false` — лишние публичные точки входа с тем же кодом отключены.
> Кастомный домен `api.ai-traffic-pro.ru` требует переноса NS зоны на Cloudflare
> (CNAME-setup и subdomain-setup доступны только на Business/Enterprise) — пока
> основной адрес `workers.dev`, сайт от этого не зависит.

### VPS (резервный API)

1. `scp`/`rsync` `server/` в `/opt/freelance/projects/ai-traffic-pro/server/`
2. `.env` с секретами (chmod 600): Telegram-токен, `chat_id`, `LLM_*`, `LLM_PROXY`, `ALLOWED_ORIGINS`
3. `pm2 startOrRestart ecosystem.config.cjs` (порт 3001)
4. nginx-vhost `api.ai-traffic-pro.ru`: `location /api/` → `127.0.0.1:3001`
5. Сертификат поддомена: `/opt/certbot-venv/bin/certbot certonly --webroot -w <dist> -d api.ai-traffic-pro.ru`
   (автообновление — `certbot.timer` + `/etc/cron.d/certbot`; проверено `renew --dry-run`)

CORS: `ALLOWED_ORIGINS` в `.env` — белый список origin'ов статики. Открытый `*` не
используется: иначе любой сторонний сайт слал бы заявки от имени нашего домена.
На Worker то же самое — `ALLOWED_ORIGINS` в секретах.

> Apex-сертификат на VPS (`ai-traffic-pro.ru`) оставлен для возможного отката,
> но его автообновление **отключено** (`/etc/letsencrypt/renewal/ai-traffic-pro.ru.conf.disabled`):
> после переключения DNS на GitHub Pages HTTP-01-челлендж до VPS не доходит и renew падал бы.

### certbot на VPS: какой бинарник рабочий

`/usr/bin/certbot` (системный 1.21.0) **сломан**: pip-пакеты в
`/usr/local/lib/python3.10/dist-packages` (urllib3 2.x) перекрывают системный
urllib3, и старый `requests_toolbelt` падает с `ImportError`. Из-за этого автообновление
не работало ни для одного сертификата на VPS.

Рабочая версия — `/opt/certbot-venv/bin/certbot` (5.8.0), плагин `certbot-nginx`
в неё доустановлен. Поэтому:

- `certbot.service` переопределён в `/etc/systemd/system/certbot.service`
  (`ExecStart=/opt/certbot-venv/bin/certbot -q renew`);
- `/etc/cron.d/certbot` вызывает venv-версию, а не `/usr/bin/certbot`.

Проверка: `systemctl start certbot.service` → `status=0/SUCCESS`;
`certbot renew --dry-run` → «all simulated renewals succeeded».

`vezemcip.ru` — не наш домен (DNS → 88.212.208.67, регистрация истекла, обслуживает
партнёр Webnames.ru). Его renewal-конфиг на этом VPS — остаток прошлого размещения;
он ронял весь `renew`, поэтому отключён: `renewal/vezemcip.ru.conf.disabled`.

## Перед продакшеном

Осталось от Игоря (полный список — `docs/CONTENT_SPEC.md`, раздел 8):

- [x] контакты: телефон, ИП, адрес, реквизиты → `SITE.legal` в `src/data/site.ts`
- [x] тексты политики и согласия
- [x] токен Telegram-бота для приёма заявок
- [x] решение по 6-й услуге (28.10.2026): 06 = e-commerce (интернет-магазин + WB/Ozon),
      CRM — дополнительное направление, `/services/marketplace/` → 301 на e-commerce
- [x] HTTPS на домене (сертификат GitHub Pages, `https_enforced`), API — на поддомене
- [x] email для связи: `erik03132@gmail.com` (`SITE.legal.email`) — пока личная
      почта, не доменная; при заведении `@ai-traffic-pro.ru` обновить `src/data/site.ts`
- [ ] мобильные экраны в Stitch (адаптив сейчас сделан на глаз)

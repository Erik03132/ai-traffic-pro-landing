# AI-Traffic PRO — сайт маркетингового агентства

Домен: `https://ai-traffic-pro.ru` · Стек: Astro 5+ (static) + Tailwind 4 · API: Cloudflare Worker (резерв — Node на VPS)

## Что здесь

Сайт собран из UI-макета Stitch и превращён в живой продукт: рабочие кнопки, рабочие
формы, чат-виджет, SEO-разметка и GEO-слой.

```
src/
  data/site.ts        ← канон, контакты, реквизиты, API, тексты главной
  data/services/*.ts  ← тексты страниц услуг: 7 файлов по одной услуге
  data/types.ts       ← тип `Service`: какие поля обязательны, какие опциональны
  layouts/Base.astro  ← обвязка: мета, canonical, OG, JSON-LD, скрипты
  components/         ← Header, Hero, Services, Approach, Process, Method,
                         ContactSection, LeadForm, Faq, Footer, ChatWidget
  pages/
    index.astro           главная
    services/[slug].astro шаблон всех страниц услуг (6 основных + e-commerce)
    privacy.astro         политика конфиденциальности
    consent.astro         согласие на обработку ПДн
  styles/global.css   ← токены Editorial Warm: Plus Jakarta Sans,
                         Instrument Serif (акценты), JetBrains Mono
server/
  agent-core.js     ← ОБЩАЯ ЛОГИКА API: база знаний, валидация заявки, формат
                      сообщения Telegram. Один источник истины для Worker и VPS
  server.js         ← Node-сервер на VPS (резерв): /api/lead, /api/chat
worker/
  src/index.js      ← Cloudflare Worker (основной API): /api/lead, /api/chat
  wrangler.jsonc    ← биндинги: KV лидов, Workers AI, rate limit, секреты
src/lib/api-post.ts ← POST с резервным адресом: повтор только при сетевой ошибке
docs/CONTENT_SPEC.md  ← спека контента с обоснованиями
docs/adr/            ← архитектурные решения (ADR-001: API на Worker,
                       ADR-002: единый шаблон страницы услуги,
                       ADR-003: редизайн одним релизом + план отката)
docs/design/SPEC-multi-landing.md ← стандарт страницы услуги: H1, типографика,
                      палитра, компоненты, модель данных, чек-лист
CONTEXT.md           ← доменные термины: метрики, каналы, e-commerce, стек
```

> **Правило:** тексты живут только в `src/data/`. Услуги — в `src/data/services/<slug>.ts`,
> контакты и канон — в `src/data/site.ts`. В разметке страниц текстов нет — всё
> генерируется из данных. Это убирает расхождения между страницами.

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

Схема размещения: **статика на Cloudflare Pages, API на Cloudflare Worker, VPS в резерве**.
Решения зафиксированы в [ADR-001](docs/adr/ADR-001-api-on-cloudflare-worker.md) (API) и
в задаче 0.8 `docs/ROADMAP.md` (статика).

| Что                       | Где                                    | Адрес                                                        |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Статика (Astro → `dist/`) | Cloudflare Pages (**прод**)            | `https://ai-traffic-pro.ru`                                   |
| Статика (резерв)          | GitHub Pages                           | сборка `deploy.yml` остаётся зелёной, но домен на неё не смотрит |
| API (заявки, чат)         | Cloudflare Worker (основной)           | `https://ai-traffic-pro-api.erik03132.workers.dev`           |
| API (заявки, чат)         | Node-сервер на VPS `217.149.23.113`    | `https://api.ai-traffic-pro.ru` (резерв, nginx/Ubuntu)        |

DNS: NS зоны `ai-traffic-pro.ru` — `kolton.ns.cloudflare.com` и `daphne.ns.cloudflare.com`.
`ai-traffic-pro.ru`, `www` и `api` отдаёт Cloudflare (A-записи `104.21.46.228`,
`172.67.142.183`), сертификаты — на стороне Cloudflare.

**Что даёт Cloudflare Pages и почему туда переезжаем:** GitHub Pages не умеет
`_headers` — security-заголовки и `Cache-Control: immutable` для `/_astro/` там
недоступны (`max-age=600`). Pages даёт и то, и другое через `public/_headers`,
плюс 301-редиректы в 1 хоп (`public/_redirects`), свой 404 без soft-404,
бесплатный preview-деплой на каждый PR и bandwidth без тарификации.

> **Переезд сделан.** NS домена перенесены на Cloudflare, поэтому кастомный домен
> на Pages заработал: `ai-traffic-pro.ru` отдаёт сборку из Cloudflare Pages.
> GitHub Pages остаётся резервным каналом (workflow `deploy.yml`), но прод —
> на Pages.

Статика собирается в CI: пуш в `main` → `.github/workflows/deploy.yml` → Astro build →
артефакт `dist` → Pages. Адреса API подставляются на этапе сборки через GitHub
Actions variables `PUBLIC_API_BASE_URL` и `PUBLIC_API_FALLBACK_URL`. Пустая
переменная = API на том же домене (локальная сборка, nginx-проксирование).

### Ручной деплой статики (когда CI не может)

CI-деплой в Cloudflare Pages требует секретов `CLOUDFLARE_API_TOKEN` и
`CLOUDFLARE_ACCOUNT_ID`: без них шаг печатает заметку в summary и пропускается.
Тогда статику выкладываем с машины (нужен `wrangler login`):

```bash
npm run build
npx wrangler pages deploy dist --project-name ai-traffic-pro --branch main --commit-dirty=true
```

**Известный блокер: `fetch failed` / `write EPIPE` на `POST /pages/assets/upload`.**
Причина не в сайте и не в токене — Node отправляет TLS ClientHello с пост-квантовым
key share `X25519MLKEM768`, и на части каналов до `api.cloudflare.com` такой пакет
не проходит (curl идёт с `X25519` и работает). Лечится форсированием классического
ECDH для процесса wrangler:

```bash
cat > /tmp/force-x25519.cjs <<'JS'
const tls = require('tls');
if (!tls.__nomlkemPatched) {
  tls.__nomlkemPatched = true;
  const orig = tls.connect;
  tls.connect = function (...args) {
    if (args[0] && typeof args[0] === 'object') {
      args[0] = Object.assign({ ecdhCurve: 'X25519:P-256' }, args[0]);
    }
    return orig.apply(this, args);
  };
}
JS

NODE_OPTIONS="--require /tmp/force-x25519.cjs" \
  npx wrangler pages deploy dist --project-name ai-traffic-pro --branch main --commit-dirty=true
```

Проверка после деплоя (все три пункта обязательны):

```bash
curl -sI https://ai-traffic-pro.ru/ | head -3                       # 200, server: cloudflare
curl -s  https://ai-traffic-pro.ru/ | grep -o '<title>[^<]*'        # title из dist/index.html
curl -s -o /dev/null -w "%{http_code}\n" https://ai-traffic-pro.ru/blog/   # 200
```

Размер HTML с прода больше локального на ~243 байта — это вставка Cloudflare
(авто-скрипт), не расхождение сборки.

### Адреса API и резерв

Адреса API приходят из окружения сборки, а не из репозитория:

| Переменная                | Где задана                              | Значение                                       |
| ------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `PUBLIC_API_BASE_URL`     | Cloudflare Pages → production env_vars  | `https://ai-traffic-pro-api.erik03132.workers.dev` |
| `PUBLIC_API_FALLBACK_URL` | Cloudflare Pages → production env_vars  | `https://api.ai-traffic-pro.ru`                |

**Резерв срабатывает только при сетевой ошибке.** Если Worker недоступен по сети
(троттлинг трафика из РФ, обрыв), запрос уходит на VPS. На 5xx повтора нет:
сервер ответил — значит заявка могла уйти, повтор дал бы клиенту две заявки.
Если не сработало ни то, ни другое, форма показывает ссылку в Telegram с уже
готовым текстом заявки.

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

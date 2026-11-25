# AI-TRAFFIC-PRO — сайт маркетингового агентства

Домен: `https://ai-traffic-pro.ru` · Стек: Astro 5+ (static) + Tailwind 4 · API: Cloudflare Worker (резерв отключён)

> **Каноничный репозиторий (SSoT):** <https://github.com/Erik03132/ai-traffic-pro-landing>, ветка `main`; рабочая копия — `~/freelance-2026/projects/ai-marketing`. Доказательства и список не-источников — `CONTEXT.md`.

## Что здесь

Сайт собран из UI-макета Stitch и превращён в живой продукт: рабочие кнопки, рабочие
формы, чат-виджет, SEO-разметка и GEO-слой.

```
src/
  data/site.ts        ← канон, контакты, реквизиты, API, тексты главной
  data/services/*.ts  ← тексты страниц услуг: 7 файлов по одной услуге
  data/blog/*.ts      ← статьи блога: одна статья — один файл
  data/types.ts       ← типы `Service`, `Article`, `ArticleBlock`
  lib/feed.ts         ← сборка `/rss.xml`: полный текст, обложки, стабильный guid
  pages/rss.xml.ts    ← лента блога (вход для Дзена и читалок, ADR-005)
  layouts/Base.astro  ← обвязка: мета, canonical, OG, JSON-LD, автодискавери ленты
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
docs/distribution/    ← реестр публикаций и тексты постов (ADR-005)
docs/adr/            ← архитектурные решения (ADR-001: API на Worker,
                       ADR-002: единый шаблон страницы услуги,
                       ADR-003: редизайн одним релизом + план отката,
                       ADR-004: аналитика и контракт целей,
                       ADR-005: дистрибуция контента — реестр, очередь, адаптеры)
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
| `GET /api/chat/log/` | Вопросы и ответы из виджета (токен; `format=text` — читаемо) |
| `GET /api/health/` | Проверка живости (`{"ok":true,"telegram":true}`) |
| `POST /api/tg/webhook/` | Апдейты Telegram: кнопки публикации и сообщения боту |
| `POST /api/tg/preview/` | Черновик поста в личку владельцу (токен) |
| `POST /api/tg/media/`   | Заменить обложку и подпись уже вышедшего поста (токен) |
| `GET /api/tg/sources/`  | Отчёт «сколько пришло с какой метки» (токен) |
| `POST /api/tg/init/`    | Перерегистрировать webhook (токен) |
| `POST /api/dist/run/`   | Прогнать очередь публикаций вручную (токен) |

**Очередь публикаций (ADR-005).** `src/pages/distribution/manifest.json.ts`
собирает из реестра и текстов постов служебный манифест
`/distribution/manifest.json`. Cron Worker каждое утро берёт первую запись,
у которой наступила дата, и присылает черновик в личку владельцу — в канал
пост уходит только по кнопке. Повторная отправка защищена метками в KV:
`sent:tg:<id>` (черновик уже ушёл) и `pub:tg:<id>` (пост уже вышел).
Прогнать очередь, не дожидаясь утра:

```bash
curl -X POST https://ai-traffic-pro-api.erik03132.workers.dev/api/dist/run \
  -H "Authorization: Bearer $TG_PUBLISH_TOKEN"
```

Telegram настроен: заявки и вопросы с сайта идут в личный аккаунт `@erik03132`,
публикация постов — через служебный бот `@aitraffic_publish_bot`.
Если токен недоступен или Telegram вернул ошибку — заявка не теряется: Worker
пишет её в Workers KV (binding `LEADS`) **до** отправки в Telegram, Node-сервер
на VPS — в `server/leads/YYYY-MM-DD.jsonl`, и оба отвечают успехом.

### Бот и метки источников

Контакт с сайта (подвал, виджет, форма) ведёт на личный аккаунт владельца
`https://t.me/erik03132` — решение 18.11.2026. Публикационный бот
`@aitraffic_publish_bot` остаётся служебным: очередь постов и разбор
`/start <метка>` для меток источников в рекламных ссылках.

- `/start` без метки → `direct`.
- Вопрос клиента бот не консультирует: пересылает в чат владельца, клиенту
  отвечает «вопрос получили». Молчание дороже плохого ответа.
- Бот не может написать первым: чтобы уведомления доходили, владелец должен
  один раз нажать Start в `@aitraffic_publish_bot`.

> **Один бот — две роли (16.11.2026).** `@aitraffic_publish_bot` публикует
> посты в канал и он же принимает вопросы с сайта: вебхук один, обработчик
> один. Прежний `@ai_bureau_new_bot` не используется — Hermes периодически
> забирает его в long polling и снимает вебхук, из-за чего заявки с сайта
> уходили в пустоту. Если появится отдельный контактный бот — поменять
> `SITE.bot` в `src/data/site.ts` и одну строку в `public/llms.txt`.

Отчёт по источникам (секрет `TG_PUBLISH_TOKEN`):

```bash
curl -H "Authorization: Bearer $TG_PUBLISH_TOKEN" \
  https://ai-traffic-pro-api.erik03132.workers.dev/api/tg/sources
# {"total":12,"returning":4,
#  "sources":[{"label":"ai_traffic_pro","count":9},{"label":"direct","count":3}],
#  "lastTouch":[{"label":"ai_traffic_pro","count":4}]}
```

Считается по записям KV, а не счётчиком: инкремент в KV не атомарный, а ошибку в
счётчике не восстановить. Два среза: `sources` — первое касание (не
перезаписывается), `lastTouch` — последнее (видно, какая кампания вернула
человека), `returning` — сколько вернулись.

### Вопросы из виджета

Виджет отвечает сам, поэтому каждый вопрос **и ответ** пишутся в KV с TTL 30
дней — `chat:q:<время>:<id>`. Ответ лежит в той же записи (`a`, до 1 000
символов), а не отдельной: записей от этого не больше, растёт только размер.
Вопросы, похожие на клиента (цена, сроки, договор, заявка), сразу уходят в
Telegram владельцу; остальные — суточным дайджестом в 10:00 МСК (cron
`0 7 * * *` UTC). Потолок пушей — 20 в час, чтобы публичный виджет не залил чат
спамом.

Читать лог удобнее текстом — диалог «вопрос → ответ» за день:

```bash
tools/chat-log.sh                # сегодня (МСК)
tools/chat-log.sh --day 2026-11-15
tools/chat-log.sh --json --limit 20
```

Токен скрипт берёт из `.env`, в вывод его не печатает. То же самое руками:

```bash
curl -H "Authorization: Bearer $TG_PUBLISH_TOKEN" \
  "https://ai-traffic-pro-api.erik03132.workers.dev/api/chat/log?format=text&day=$(date +%F)"
# Вопросы из виджета за 16.11.2026 — 9
#
# 13:30  /services/web/  [база знаний]
#   ? Сколько стоит сайт под ключ?
#   → Стоимость — по запросу. Смета зависит от объёма работ…
```

Без `day` — все записи, без `format=text` — JSON:

```bash
curl -H "Authorization: Bearer $TG_PUBLISH_TOKEN" \
  "https://ai-traffic-pro-api.erik03132.workers.dev/api/chat/log?limit=20"
# {"total":3,"items":[{"q":"Сколько стоит сайт?","a":"…","source":"knowledge","ts":"…"}]}
```

`source` в записи — откуда ушёл ответ: `knowledge`, `llm` или `fallback`. Если
`fallback` часто — база знаний не покрывает то, о чём спрашивают. Записи до
16.11.2026 ответа не содержат: тогда писались только вопросы.

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

## Блог и RSS-лента

Статьи блога лежат в `src/data/blog/*.ts` (одна статья — один файл), собираются
в страницы `/blog/<slug>/` и в ленту `/rss.xml`.

Лента отдаёт **полный текст** статьи, обложку (`enclosure`), автора, дату и
`guid`, равный каноническому адресу. Даты берутся из поля `date` статьи, а
`lastBuildDate` — дата самой свежей публикации: пересборка сайта не выглядит
для читалок как «вышло 11 новых статей».

Зачем: это вход в Дзен (у него нет API публикации, только трансляция RSS),
агрегаторы и RSS-читалки. Требования Дзена к ленте (`content:encoded`,
`enclosure`, ≥ 700 px обложка, ≥ 10 материалов в первой подаче) соблюдены
заранее — см. [ADR-005](docs/adr/ADR-005-content-distribution.md).

Проверка:

```bash
npm run build && xmllint --noout dist/rss.xml && grep -c '<item>' dist/rss.xml
node --test src/lib/feed.test.ts
```

`<link rel="alternate" type="application/rss+xml">` стоит в `<head>` всех
страниц, поэтому ридеры находят ленту сами. Разметка у каждой статьи — в
`<item>`: изменить состав полей можно только в `src/lib/feed.ts`, шаблоны
страниц на ленту не влияют.

## Деплой

Схема размещения (фактическая на 24.11.2026): **статика на Timeweb Cloud
App Platform (прод), API на Cloudflare Worker, DNS и почта на Cloudflare**.
Решения зафиксированы в [ADR-001](docs/adr/ADR-001-api-on-cloudflare-worker.md) (API) и
в задаче 0.8 `docs/ROADMAP.md` (статика).

| Что                       | Где                                        | Адрес                                                        |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Статика (Astro → `dist/`) | **Timeweb Cloud App Platform** (прод)      | `https://ai-traffic-pro.ru`                                   |
| Статика (резерв)          | GitHub Pages                               | `deploy.yml` остаётся зелёным, домен на него не смотрит       |
| API (заявки, чат)         | Cloudflare Worker                          | `https://ai-traffic-pro-api.erik03132.workers.dev`            |
| API (резерв)              | —                                          | нет: `api.ai-traffic-pro.ru` отдаёт 522 (см. ниже)            |

Приложение Timeweb: id `294905`, регион Москва (`ru-3`), IP `178.209.127.53`,
тариф «frontend request preset MSK» — 1 ₽/мес + 4,95 ₽ за 10 000 входящих
запросов, 2 ГБ NVMe. Домен-источник: `Erik03132/ai-traffic-pro-landing`,
ветка `main`.

DNS: NS зоны `ai-traffic-pro.ru` — `kolton.ns.cloudflare.com` и
`daphne.ns.cloudflare.com`. `ai-traffic-pro.ru` и `www` — A-запись
`178.209.127.53`, DNS only (без прокси Cloudflare), сертификат Let's Encrypt
выпускает и продлевает Timeweb.

**Зачем переехали с GitHub Pages:** коммерческое использование на GitHub Pages
запрещено ToS, `_headers` там не применяются (`max-age=600`, без HSTS/CSP), а
юрисдикция — США. Timeweb: российский хостинг (152-ФЗ), заголовки и редиректы
в панели, gzip на Edge, оплата по запросам.

> **Cloudflare Pages не используется.** Попытка 23.11 провалилась: с прокси
> Cloudflare отдавался **обрезанный HTML** (HTTP/2 — обрыв, нет `</html>`;
> HTTP/1.1 — цело; `pages.dev` напрямую — всегда цело). DNS откатили, потом
> переехали на Timeweb — там HTTP/2 отдаёт те же 123 129 байт, что и локальная
> сборка (6/6 замеров). Workflow `deploy-pages.yml` оставлен, но домен на
> Pages не смотрит.

### Деплой статики

Сборку и раздачу делает Timeweb: он забирает код из GitHub по URL, собирает
(`npm run build`, Astro, Node.js 24) и публикует `/dist`. Переменные сборки
заданы в настройках приложения (`PUBLIC_API_BASE_URL`, `PUBLIC_YM_COUNTER_ID`).

**Автодеплоя по пушу нет:** репозиторий подключён по URL, а не через OAuth,
поэтому GitHub-webhook не выдаётся (`is_allowed_webhook: false`). Деплой —
ручной: панель Timeweb → приложение `ai-traffic-pro` → «Деплой» →
«Запустить деплой» (или API `POST /api/v1/apps/294905/deploy`).

Пуш в `main` по-прежнему запускает `.github/workflows/deploy.yml` (GitHub
Pages) — это резервный канал, прод он не обновляет.

Проверка после деплоя:

```bash
curl -sI https://ai-traffic-pro.ru/ | grep -iE 'server|strict-transport|content-security'  # server: Caddy + заголовки
curl -s https://ai-traffic-pro.ru/ | wc -c                                                # 123129
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://www.ai-traffic-pro.ru/   # 301 → apex
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://ai-traffic-pro.ru/services/marketplace/  # 301 → /services/ecommerce/
```

### Заголовки и редиректы (замена `_headers` / `_redirects`)

`public/_headers` и `public/_redirects` — формат Cloudflare Pages; на Timeweb
они не применяются (файлы уезжают в `dist`, но сервер их не читает). Источник
истины теперь — панель: «Настройки веб-сервера».

| Правило                                        | Значение                                                      |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `X-Content-Type-Options` / `X-Frame-Options`   | `nosniff` / `DENY`                                            |
| `Referrer-Policy` / `Permissions-Policy`       | `strict-origin-when-cross-origin` / см. `_headers`             |
| `Strict-Transport-Security`                    | `max-age=31536000` (без `includeSubDomains`)                  |
| `Content-Security-Policy`                      | как в `_headers` (Яндекс.Метрика, Google Fonts, Worker)        |
| Редирект `www` → apex                          | host `www.ai-traffic-pro.ru` → `ai-traffic-pro.ru`, 301        |
| Редирект `/services/marketplace/`              | → `/services/ecommerce/`, 301                                 |
| Сжатие                                         | gzip                                                          |

Ограничения Timeweb: 10 правил заголовков и 10 редиректов на приложение;
`Cache-Control` задаётся глобально, поэтому `immutable` только для `/_astro/`
(как в `_headers`) не воспроизводится.

### Адреса API и резерв

Адреса API приходят из окружения сборки, а не из репозитория:

| Переменная                | Где задана                              | Значение                                       |
| ------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `PUBLIC_API_BASE_URL`     | Timeweb → приложение → Переменные        | `https://ai-traffic-pro-api.erik03132.workers.dev` |
| `PUBLIC_API_FALLBACK_URL` | не задана                                | пусто                                          |

**Резерв срабатывает только при сетевой ошибке.** Если Worker недоступен по сети
(троттлинг трафика из РФ, обрыв), запрос уходит на резервный адрес.
На 5xx повтора нет: сервер ответил — значит заявка могла уйти, повтор дал бы
клиенту две заявки. Если не сработало ни то, ни другое, форма показывает ссылку
в Telegram с уже готовым текстом заявки.

> **Резерва у API сейчас нет.** VPS `217.149.23.113` выключен (отдаёт `000`),
> `api.ai-traffic-pro.ru` — CNAME на Worker, но через прокси Cloudflare отдаёт
> **522** (Cloudflare не проксирует `*.workers.dev` под своим доменом). Форма
> этот адрес не использует: в сборке задан только `PUBLIC_API_BASE_URL`. Чтобы
> резерв появился, нужен либо отдельный Worker, либо Worker Custom Domain
> (`api.ai-traffic-pro.ru`) — второе требует токена с правами Workers.

### Аналитика (Яндекс.Метрика)

Номер счётчика приходит из окружения сборки, в репозитории его нет:

| Переменная           | Где задана                                          |
| -------------------- | --------------------------------------------------- |
| `PUBLIC_YM_COUNTER_ID` | Timeweb → приложение → Переменные (`114006019`)      |

Пустое значение = счётчика нет: `Analytics.astro` не рендерится, `reachGoal()`
превращается в no-op. Так dev и превью не засоряют статистику.

**Четыре цели — контракт с интерфейсом счётчика.** Имена в Метрике должны
совпадать символ в символ, иначе события уйдут в никуда:

| Цель          | Когда срабатывает                                      | Где код                          |
| ------------- | ------------------------------------------------------ | -------------------------------- |
| `lead_submit` | заявка успешно ушла на API (не клик по кнопке)          | `LeadForm.astro`                 |
| `phone_click` | клик по любой ссылке `tel:` (считается каждый клик)     | `Analytics.astro`                |
| `chat_open`   | первое открытие виджета за страницу                     | `ChatWidget.astro`               |
| `scroll_75`   | дочитал до 75 % высоты прокрутки (один раз за страницу) | `Analytics.astro`                |
| `widget_lead` | контакт оставлен прямо в виджете (ответ `/api/lead` ок) | `ChatWidget.astro`               |

Проверка после деплоя: `/webvisor/` не нужен — откройте
`https://ai-traffic-pro.ru/?_ym_debug=1`, в консоли выполните `window.ym
(window.__ymCounterId, 'reachGoal', 'test_goal')` и убедитесь, что цель видна в
Метрике → «Цели» → «Конверсии» в течение ~30 секунд.

Webvisor выключен осознанно (формы собирают телефоны и имена, 152-ФЗ). Решение
и условия включения — `docs/adr/ADR-004-analytics-goals.md`.

### Worker (основной API)

Деплой: `npm run worker:deploy` (wrangler, конфиг `worker/wrangler.jsonc`).
Логи в реальном времени: `npm run worker:tail`.

Секреты — только через `wrangler secret put` (в репозитории их нет):

| Секрет             | Назначение                                      |
| ------------------ | ----------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | отправка заявок в чат владельца, приём `/start` |
| `TELEGRAM_CHAT_ID` | чат-владелец (заявки, уведомления о входах)     |
| `TELEGRAM_WEBHOOK_SECRET` | подпись апдейтов Telegram (`X-Telegram-Bot-Api-Secret-Token`) |
| `TG_PUBLISH_TOKEN` | токен эндпоинтов публикации и отчёта по меткам  |
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
> после переключения DNS на Timeweb HTTP-01-челлендж до VPS не доходит и renew падал бы.

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
- [x] HTTPS на домене (сертификат Let's Encrypt от Timeweb, прод — App Platform), API — на поддомене
- [x] email для связи: `erik03132@gmail.com` (`SITE.legal.email`) — пока личная
      почта, не доменная; при заведении `@ai-traffic-pro.ru` обновить `src/data/site.ts`
- [ ] мобильные экраны в Stitch (адаптив сейчас сделан на глаз)

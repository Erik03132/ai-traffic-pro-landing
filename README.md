# AI-Traffic PRO — сайт маркетингового агентства

Домен: `https://ai-traffic-pro.ru` · Стек: Astro 5+ (static) + Tailwind 4 · Сервер заявок: Node (без зависимостей)

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
server/server.js      ← приём заявок (/api/lead) и чат-бот (/api/chat)
docs/CONTENT_SPEC.md  ← спека контента с обоснованиями
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

Сайт — статика, поэтому заявки принимает отдельный Node-сервер:

| Эндпоинт           | Назначение                                       |
| ------------------ | ------------------------------------------------ |
| `POST /api/lead/`  | Заявка с формы → Telegram + резервный JSONL-файл |
| `POST /api/chat/`  | Вопрос из виджета → база знаний, иначе LLM       |
| `GET /api/health/` | Проверка живости (`{"ok":true,"telegram":true}`) |

Telegram настроен: бот `@ai_bureau_new_bot`, заявки приходят в чат владельца.
Если токен недоступен или Telegram вернул ошибку — заявка не теряется: сервер
пишет её в `server/leads/YYYY-MM-DD.jsonl` и отвечает успехом.

LLM отвечает на вопросы вне базы знаний. Провайдер — любой OpenAI-совместимый
эндпоинт (`LLM_BASE_URL` + `LLM_MODEL`), запасной — `LLM_FALLBACK_*`. Внешние
провайдеры из РФ идут через SOCKS5 (`LLM_PROXY`) — свой клиент `server/socks.js`,
без npm-зависимостей. Если LLM недоступен — виджет отвечает по базе знаний,
а не «пустым» сообщением.

## Деплой

Схема размещения: **статика на GitHub Pages, API на VPS**.

| Что                       | Где                               | Адрес                           |
| ------------------------- | --------------------------------- | ------------------------------- |
| Статика (Astro → `dist/`) | GitHub Pages                      | `https://ai-traffic-pro.ru`     |
| API (заявки, чат)         | VPS `217.149.23.113`, nginx + pm2 | `https://api.ai-traffic-pro.ru` |

DNS: A-записи `ai-traffic-pro.ru` и `www.ai-traffic-pro.ru` → `185.199.108.153`
(IP GitHub Pages), `api.ai-traffic-pro.ru` → `217.149.23.113`. TLS-сертификат
выпускает GitHub (Let's Encrypt, до 2027-01-04), автообновление — на стороне GitHub.

Статика собирается в CI: пуш в `main` → `.github/workflows/deploy.yml` → Astro build →
артефакт `dist` → Pages. Адрес API подставляется на этапе сборки через
GitHub Actions variable `PUBLIC_API_BASE_URL` (`https://api.ai-traffic-pro.ru`).
Пустая переменная = API на том же домене (локальная сборка, nginx-проксирование).

VPS-часть:

1. `scp`/`rsync` `server/` в `/opt/freelance/projects/ai-traffic-pro/server/`
2. `.env` с секретами (chmod 600): Telegram-токен, `chat_id`, `LLM_*`, `LLM_PROXY`, `ALLOWED_ORIGINS`
3. `pm2 startOrRestart ecosystem.config.cjs` (порт 3001)
4. nginx-vhost `api.ai-traffic-pro.ru`: `location /api/` → `127.0.0.1:3001`
5. Сертификат поддомена: `/opt/certbot-venv/bin/certbot certonly --webroot -w <dist> -d api.ai-traffic-pro.ru`
   (автообновление — `certbot.timer` + `/etc/cron.d/certbot`; проверено `renew --dry-run`)

CORS: `ALLOWED_ORIGINS` в `.env` — белый список origin'ов статики. Открытый `*` не
используется: иначе любой сторонний сайт слал бы заявки от имени нашего домена.

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

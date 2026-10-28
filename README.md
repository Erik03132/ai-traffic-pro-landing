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
    services/[slug].astro шаблон всех страниц услуг (6 + маркетплейс)
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

Прод — VPS `217.149.23.113` (nginx + pm2), DNS домена уже указывает на него,
сертификат Let's Encrypt выпущен и обновляется автоматически.

1. `npm run build` → скопировать `dist/` в `/opt/freelance/projects/ai-traffic-pro/dist`
2. nginx: `server_name ai-traffic-pro.ru`, `root` → dist, `location /api/` → `127.0.0.1:3001`
3. `pm2 startOrRestart ecosystem.config.cjs`, `.env` с секретами (chmod 600)
4. Сертификат: `/opt/certbot-venv/bin/certbot certonly --webroot -w <dist> -d ai-traffic-pro.ru -d www.ai-traffic-pro.ru`

## Перед продакшеном

Осталось от Игоря (полный список — `docs/CONTENT_SPEC.md`, раздел 8):

- [x] контакты: телефон, ИП, адрес, реквизиты → `SITE.legal` в `src/data/site.ts`
- [x] тексты политики и согласия
- [x] токен Telegram-бота для приёма заявок
- [x] решение по 6-й услуге (CRM подтверждена, маркетплейс — вне списка)
- [ ] email на домен (`SITE.legal.email` — пусто, футер не выводит пустую ссылку)
- [ ] мобильные экраны в Stitch (адаптив сейчас сделан на глаз)

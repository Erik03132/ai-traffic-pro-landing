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

| Эндпоинт | Назначение |
|---|---|
| `POST /api/lead/` | Заявка с формы → Telegram + резервный JSONL-файл |
| `POST /api/chat/` | Вопрос из виджета → база знаний, иначе LLM (OpenRouter) |
| `GET /api/health/` | Проверка живости |

Токен Telegram сейчас **не настроен** (`@aibureau_bot` отдаёт 401). Пока токена нет,
заявки не теряются: сервер пишет их в `server/leads/YYYY-MM-DD.jsonl`. Как только
появится токен — заполните `.env` (образец в `.env.example`), и заявки пойдут в Telegram.

## Деплой

Сайт сейчас на GitHub Pages — статика, POST не примет. Нужен перенос на VPS
`217.149.23.113` (nginx, те же NS, что у домена):

1. `npm run build` → скопировать `dist/` в `/opt/freelance/ai-traffic-pro/dist`
2. nginx: `server_name ai-traffic-pro.ru`, `root` → dist, `location /api/` → `127.0.0.1:3001`
3. `pm2 start server/server.js`, `.env` с секретами
4. DNS: A-записи домена → `217.149.23.113` (вместо GitHub Pages)

## Перед продакшеном

Осталось от Игоря (полный список — `docs/CONTENT_SPEC.md`, раздел 8):

- [ ] контакты: телефон, email, юрлицо/ИП, адрес → `SITE.legal` в `src/data/site.ts`
- [ ] тексты политики и согласия (шаблоны лежат в `src/pages/`)
- [ ] токен Telegram-бота для приёма заявок
- [ ] решение по 6-й услуге (CRM подтверждена, маркетплейс — вне списка)
- [ ] мобильные экраны в Stitch (адаптив сейчас сделан на глаз)

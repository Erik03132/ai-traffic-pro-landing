# Отправка постов в Telegram с подтверждением

Черновик приходит в личный чат с ботом, под ним две кнопки: **«✅ Опубликовать
в канал»** и **«❌ Отклонить»**. В канал пост уходит только по кнопке — вместе
с кнопкой-ссылкой «Читать статью →».

```
tools/tg-publish/send.py  →  Worker /api/tg/preview  →  бот в личный чат
                                                          ↓ нажатие кнопки
                                    Worker /api/tg/webhook  →  канал
```

## Что нужно один раз

1. **Бот — администратор канала.** Telegram → канал → «Управляющие» →
   «Добавить администратора» → найти `@ai_bureau_new_bot` → разрешить
   «Публикация сообщений». Без этого кнопка «Опубликовать» вернёт ошибку прав,
   и в ответе будет причина.
2. **Секреты Worker** (уже стоят): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `TG_PUBLISH_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, переменные `SITE_URL` и
   `TELEGRAM_CHANNEL_ID` в `worker/wrangler.jsonc`.
3. **Токен для отправки** — `TG_PUBLISH_TOKEN` в `.env` в корне проекта
   (файл в `.gitignore`, в репозиторий не попадает).
4. **Вебхук для кнопок** — регистрируется один раз:

```bash
curl -X POST https://ai-traffic-pro-api.erik03132.workers.dev/api/tg/init \
  -H "Authorization: Bearer $TG_PUBLISH_TOKEN"
```

## Как отправить пост

```bash
# текст из docs/distribution/posts/<slug>.md
python3 tools/tg-publish/send.py --slug crm-i-erp-raznica

# конкретный пост про статью (utm_content=post-2)
python3 tools/tg-publish/send.py --slug crm-i-erp-raznica \
  --text-file docs/distribution/posts/crm-i-erp-raznica.post-2.md --content post-2

# проверить текст, ничего не отправляя
python3 tools/tg-publish/send.py --slug test --text "Проверка [ссылки]({{link}})." --dry-run
```

## Как писать текст поста

- Ссылка — только как `[фраза]({{link}})`. Адрес с `utm_source=telegram`,
  `utm_medium=social`, `utm_campaign=<slug>` и `utm_content` подставит Worker.
  Руками адрес не пишем: опечатка в метке = потерянный источник.
- Длина — до 4096 символов (лимит Telegram, проверяется при отправке).
- Одна ссылка на пост: вторая — читатель выбирает и не идёт никуда.
- Прежние посты и правила канала — `docs/distribution/telegram-launch.md`.

## Что дальше по каналам

Кнопки «Отправить в VK» и «Отправить в Дзен» добавляются в ту же клавиатуру
черновика, когда появятся адаптации текстов под площадки: у VK и Дзен другой
формат, копипаст одного текста площадки наказывают в выдаче.

# Дистрибуция контента

Одна статья → несколько постов → несколько площадок. Решение и ограничения —
[ADR-005](../adr/ADR-005-content-distribution.md). Здесь — как этим пользоваться
руками, пока автоподготовка (этап 2) не подключена.

## Файлы

| Файл | Что это |
|---|---|
| `registry.json` | реестр публикаций: что вышло, что ждёт, что упало и почему |
| `posts/<slug>.post-N.md` | текст поста без служебной шапки — она отрезается по `---` |
| `../../tools/publish/render.py` | рендер под площадку + проверка лимитов + статусы |
| `../../tools/tg-publish/send.py` | ручная отправка в Telegram с кнопкой «Опубликовать» |

## Статусы

```
draft ──▶ queued ──▶ approved ──▶ posted
            │           │
            └───────────┴──▶ failed ──▶ queued
```

- `draft` — статья есть, текст поста ещё не написан. Файла может не быть.
- `queued` — текст есть и проходит проверку лимитов.
- `approved` — владелец посмотрел черновик и согласен.
- `posted` — вышло; хранится `messageId` и ссылка (или `legacyNote`, если пост
  вышел до появления реестра).
- `failed` — обязательна причина в `error`. Тихий пропуск запрещён.

Назад из `posted` нельзя: пост в чужой ленте уже вышел.

## Команды

```bash
# Проверить весь реестр (гейт в CI и в npm test)
npm run dist:check

# Что уйдёт в канал: текст со вставленной UTM-ссылкой, длина, замечания
python3 tools/publish/render.py --all
python3 tools/publish/render.py --id voronka-prodazh-kak-postroit:post-1:telegram

# Двинуть статус (сначала посмотреть, что изменится)
python3 tools/publish/render.py --id <id> --mark approved --dry-run
python3 tools/publish/render.py --id <id> --mark posted --message-id 12 --url https://t.me/aitrafficpro/12
```

Лимит считается по готовому тексту: подстановка ссылки добавляет 60–90 символов,
поэтому проверять шаблон бессмысленно. Для Telegram по умолчанию действует
лимит подписи к фото (1 024), с `--no-photo` — лимит сообщения (4 096).

## Автоматические черновики (этап 2)

Cron Worker (`0 7 * * *` UTC) сам присылает черновик поста в личку владельцу,
когда наступает `plannedAt`. Источник очереди — `/distribution/manifest.json`,
который собирается на билде из `registry.json` и файлов постов (git остаётся
источником истины, копий текстов в KV нет).

Проверить очередь, не дожидаясь утра:

```bash
curl -X POST https://ai-traffic-pro-api.erik03132.workers.dev/api/dist/run \
  -H "Authorization: Bearer $TG_PUBLISH_TOKEN"
# {"ok":true,"id":"geo-prodvizhenie-checklist:post-1:telegram"}
# {"ok":true,"skipped":"черновик уже отправлен"}  — повторный вызов
# {"ok":true,"skipped":"очередь пуста"}          — раньше даты публиковать нечего

# проверить отправку сразу, не дожидаясь plannedAt
curl -X POST "https://ai-traffic-pro-api.erik03132.workers.dev/api/dist/run?force=1" \
  -H "Authorization: Bearer $TG_PUBLISH_TOKEN"
# {"ok":true,"id":"geo-prodvizhenie-checklist:post-1:telegram"}
```

**Грабли `force=1`:** прогон ставит метку `sent:tg:<id>` на 3 дня. Если до
`plannedAt` осталось меньше трёх суток, утренний cron в этот день промолчит —
пост уйдёт на следующий. После проверки метку либо снимают
(`npx wrangler kv key delete --namespace-id=<LEADS> --remote "sent:tg:<id>"`),
либо оставляют: черновик уже в личке, и кнопка «Опубликовать» доводит дело
до канала.

Защита от дублей: `sent:tg:<id>` (черновик уже ушёл, живёт 3 дня) и
`pub:tg:<id>` (пост уже вышел в канал). Вторая метка ставится кнопкой
«Опубликовать» — после неё cron эту публикацию больше не предлагает.

**Статус в `registry.json` кнопка не меняет** — его двигает человек:

```bash
python3 tools/publish/render.py --id <id> --mark posted --message-id 12 --url https://t.me/aitrafficpro/12
```

Так сделано осознанно (ADR-005): git не может обновляться из Worker. Когда
ручная правка начнёт мешать, появится `dist:pull` — чтение меток из KV одной
командой.

## Как добавить публикацию

1. Написать текст в `posts/<slug>.post-N.md` (шапка + `---` + текст, ссылка —
   `[подпись]({{link}})`).
2. Добавить запись в `registry.json`: `id` = `<slug>:post-N:<channel>`, статус
   `queued`.
3. `npm run dist:check` — должно быть 0 ошибок.
4. Отправить: `python3 tools/tg-publish/send.py --slug <slug> --text-file …`
   (пока вручную; на этапе 2 черновик придёт сам).
5. После выхода — `--mark posted --message-id … --url …`.

## Куда смотреть, если что-то не так

`dist:check` перечисляет ошибки с id публикации. Частые:

- «нет файла текста» — статус выше `draft`, а текста нет;
- «статьи нет в src/data/blog» — опечатка в слаге;
- «1100 символов при лимите 1024» — пост не уйдёт в канал с фото;
- «нельзя перейти из posted в queued» — реестр защищает от повторной отправки.

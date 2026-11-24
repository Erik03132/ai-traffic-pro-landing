"""Реестр дистрибуции: единственное место, где видно «что куда ушло».

Зачем отдельный модуль: состояние публикаций нельзя держать «в голове» и нельзя
выводить из наличия файла поста. Файл `posts/<slug>.post-2.md` существует и до
публикации, и после; по нему не отличить «написан» от «вышел». Реестр отвечает
на три вопроса: что уже вышло, что ждёт, что упало и почему.

Источник истины — `docs/distribution/registry.json` в git (ревью, история,
откат). KV на Worker — только зеркало для cron (этап 2), обратной
синхронизации нет: см. ADR-005.

Модуль чистый: файловая система, никакой сети. Проверяется `test_publish.py`.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REGISTRY_PATH = os.path.join(ROOT, "docs", "distribution", "registry.json")
POSTS_DIR = os.path.join(ROOT, "docs", "distribution", "posts")
BLOG_DIR = os.path.join(ROOT, "src", "data", "blog")

#: Статусы публикации. Порядок — движение только вперёд.
STATUSES = ("draft", "queued", "approved", "posted", "failed")

#: Разрешённые переходы. Назад из `posted` нельзя: пост в чужой ленте уже вышел.
TRANSITIONS = {
    "draft": {"queued"},
    "queued": {"approved", "failed"},
    "approved": {"posted", "failed"},
    "posted": set(),
    "failed": {"queued", "approved"},
}

#: Лимиты площадок. Только проверенные числа — остальные лимиты появляются
#: вместе с адаптером, когда сверены с документацией площадки (ADR-005).
CHANNELS = {
    # Подпись к фото — 1024, обычное сообщение — 4096 (константы Worker:
    # `CAPTION_LIMIT` и `POST_LIMIT` в `worker/src/publish.js`).
    "telegram": {"limit": 1024, "limit_no_photo": 4096},
    "max": {"limit": None},
    "vk": {"limit": None},
    "dzen": {"limit": None},
    # Хабр: публикация ручная (в личном кабинете), лимитов длины нет —
    # ограничение задаёт редакция площадки, а не наш рендер. Канал в реестре
    # нужен, чтобы видеть весь выход в одном списке, а не «вне системы».
    "habr": {"limit": None},
}

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}:post-\d{1,2}:[a-z]+$")


def load(path: str = REGISTRY_PATH) -> dict:
    """Читает реестр. Ошибка чтения — исключение, а не пустой реестр.

    Пустой реестр вместо ошибки — худший вариант: cron решит, что публиковать
    нечего, и «тихо всё хорошо» будет длиться неделями.
    """
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("publications"), list):
        raise ValueError(f"{path}: ожидался объект с массивом `publications`")
    return data


def save(data: dict, path: str = REGISTRY_PATH) -> None:
    """Пишет реестр атомарно: сбой посреди записи не оставит обрезанный JSON."""
    directory = os.path.dirname(os.path.abspath(path))
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, prefix=".registry-", suffix=".json", delete=False
    )
    try:
        with handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(handle.name, path)
    except BaseException:
        os.unlink(handle.name)
        raise


def find(data: dict, entry_id: str) -> dict | None:
    """Находит публикацию по id или возвращает None."""
    for entry in data["publications"]:
        if entry.get("id") == entry_id:
            return entry
    return None


def can_transition(current: str, target: str) -> bool:
    """Можно ли перевести публикацию в статус `target`."""
    return target in TRANSITIONS.get(current, set())


def post_path(slug: str, post: str, root: str = ROOT) -> str:
    """Путь к файлу текста поста."""
    return os.path.join(root, "docs", "distribution", "posts", f"{slug}.{post}.md")


def post_text(slug: str, post: str, root: str = ROOT) -> str | None:
    """Текст поста без служебной шапки. None — файла нет.

    Шапка (заголовок, статья, статус) отделена строкой `---`. В ленту и в канал
    она попасть не должна, поэтому отрезается здесь, а не в момент отправки.
    """
    path = post_path(slug, post, root)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as handle:
        raw = handle.read()
    parts = raw.split("\n---\n", 1)
    body = parts[1] if len(parts) == 2 else raw
    return body.strip()


def blog_slugs(root: str = ROOT) -> set[str]:
    """Слаги статей, которые реально есть в блоге."""
    directory = os.path.join(root, "src", "data", "blog")
    if not os.path.isdir(directory):
        return set()
    return {
        name[:-3]
        for name in os.listdir(directory)
        if name.endswith(".ts") and name != "index.ts"
    }


def validate(data: dict, root: str = ROOT) -> list[str]:
    """Проверяет реестр. Возвращает список ошибок: пусто — всё в порядке.

    Проверка нужна как гейт: без неё реестр через месяц превращается в набор
    строк, половина которых ссылается на несуществующие файлы, а cron молча
    ничего не публикует.
    """
    errors: list[str] = []
    publications = data.get("publications", [])
    if not isinstance(publications, list):
        return ["`publications` — не массив"]

    slugs = blog_slugs(root)
    seen: set[str] = set()

    for index, entry in enumerate(publications):
        where = entry.get("id") or f"#{index}"
        if not isinstance(entry, dict):
            errors.append(f"{where}: элемент не объект")
            continue

        entry_id = entry.get("id", "")
        if not ID_RE.match(str(entry_id)):
            errors.append(f"{where}: id должен быть `<slug>:post-N:<channel>`")
        if entry_id in seen:
            errors.append(f"{where}: id повторяется")
        seen.add(entry_id)

        if entry.get("channel") not in CHANNELS:
            errors.append(f"{where}: неизвестный канал `{entry.get('channel')}`")
        if entry.get("status") not in STATUSES:
            errors.append(f"{where}: неизвестный статус `{entry.get('status')}`")

        slug = entry.get("slug", "")
        post = entry.get("post", "")
        if not re.match(r"^post-\d{1,2}$", str(post)):
            errors.append(f"{where}: post должен быть `post-N`")
        if slug not in slugs:
            errors.append(f"{where}: статьи `{slug}` нет в src/data/blog")

        planned = entry.get("plannedAt")
        if planned:
            try:
                date.fromisoformat(planned)
            except ValueError:
                errors.append(f"{where}: plannedAt не ISO-дата ({planned})")

        # Текст нужен всем, кроме `draft`: черновик — это «статья есть, пост ещё
        # не написан». Остальные статусы обещают, что текст существует.
        if entry.get("status") != "draft" and post_text(slug, post, root) is None:
            errors.append(f"{where}: нет файла текста `{slug}.{post}.md`")

        # Вышедший пост обязан оставить след: id сообщения, ссылку или
        # объяснение, почему их нет (первые публикации до реестра).
        if entry.get("status") == "posted" and not (
            entry.get("messageId") or entry.get("url") or entry.get("legacyNote")
        ):
            errors.append(f"{where}: `posted` без messageId/url/legacyNote")

    return errors


def set_status(
    data: dict,
    entry_id: str,
    target: str,
    *,
    message_id: int | None = None,
    url: str | None = None,
    error: str | None = None,
) -> dict:
    """Переводит публикацию в новый статус. Ошибка — исключение, не молчание."""
    entry = find(data, entry_id)
    if entry is None:
        raise KeyError(f"публикации `{entry_id}` нет в реестре")
    current = entry.get("status")
    if not can_transition(current, target):
        raise ValueError(f"{entry_id}: нельзя перейти из `{current}` в `{target}`")

    entry["status"] = target
    if target == "posted":
        if message_id is not None:
            entry["messageId"] = message_id
        if url:
            entry["url"] = url
        entry["error"] = None
    if target == "failed":
        # Причина обязательна: «упало» без причины — это тишина (HT-3).
        if not error:
            raise ValueError(f"{entry_id}: статус `failed` требует причину")
        entry["error"] = error
    return entry

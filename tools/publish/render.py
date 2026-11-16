#!/usr/bin/env python3
"""Рендер поста под площадку и проверка лимитов ДО отправки.

Зачем: лимит Telegram на подпись к фото — 1024 символа, и узнать об этом после
нажатия «Опубликовать» (или, хуже, после отправки в канал) — это потерянный
пост. Здесь текст собирается ровно в том виде, в котором уйдёт: подставляется
реальная UTM-ссылка (она на 60–90 символов длиннее шаблона), считается длина,
проверяются маркеры, которые площадка покажет как есть.

Что модуль НЕ делает: не отправляет и не ходит в сеть. Отправка — этап 2
(cron Worker) и `tools/tg-publish/send.py` для ручного прогона.

Примеры:

    python3 tools/publish/render.py --check
    python3 tools/publish/render.py --id kak-vybrat-kanal-prodvizheniya:post-1:telegram
    python3 tools/publish/render.py --id voronka-prodazh-kak-postroit:post-1:telegram --mark approved --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import registry  # noqa: E402  (путь добавляем выше, до импорта)

SITE = "https://ai-traffic-pro.ru"
PLACEHOLDER = "{{link}}"


def build_link(slug: str, post: str, channel: str, site: str = SITE) -> str:
    """UTM-ссылка на статью.

    Повторяет `buildLink` из `worker/src/publish.js`: те же параметры и порядок,
    иначе разрез трафика в Метрике разъедется между ручной и авто-публикацией.
    """
    query = urlencode(
        {
            "utm_source": channel,
            "utm_medium": "social",
            "utm_campaign": slug,
            "utm_content": post,
        }
    )
    return f"{site.rstrip('/')}/blog/{slug}/?{query}"


def render(template: str, link: str) -> str:
    """Подставляет ссылку в шаблон поста."""
    return template.replace(PLACEHOLDER, link)


def check_text(
    text: str, channel: str, *, has_photo: bool = True, template: str | None = None
) -> dict:
    """Проверяет готовый текст под лимиты и разметку площадки.

    `text` — то, что уйдёт в канал (со вставленной ссылкой). `template` — исходник
    с `{{link}}`: плейсхолдер проверяется по нему, иначе после подстановки его
    «нет» и проверка врёт.

    Возвращает `{ok, chars, limit, errors, warnings}`. `errors` блокируют
    публикацию, `warnings` — повод посмотреть глазами.
    """
    limits = registry.CHANNELS.get(channel, {"limit": None})
    limit = limits.get("limit") if has_photo else limits.get("limit_no_photo", limits.get("limit"))
    if limit is None:
        limit = limits.get("limit_no_photo") or limits.get("limit")

    errors: list[str] = []
    warnings: list[str] = []

    if not text.strip():
        errors.append("пустой текст")

    chars = len(text)
    if limit is not None and chars > limit:
        errors.append(f"{chars} символов при лимите {limit}: пост не уйдёт")

    placeholders = (template if template is not None else text).count(PLACEHOLDER)
    if placeholders > 1:
        errors.append(f"плейсхолдер {PLACEHOLDER} встречается {placeholders} раза")
    elif placeholders == 0:
        warnings.append("в тексте нет ссылки на статью")

    lines = text.split("\n")
    if any(line.startswith("#") for line in lines):
        warnings.append("строка начинается с `#` — площадка покажет решётку как есть")
    if "**" in text:
        warnings.append("`**` — markdown-жирный; Telegram-HTML его не понимает")
    if "\t" in text:
        warnings.append("табуляция: в редакторе площадки превратится в рваный отступ")
    if any(line != line.rstrip() for line in lines):
        warnings.append("есть строки с пробелами на конце")
    if "\n\n\n" in text:
        warnings.append("больше одной пустой строки подряд — лишний воздух в ленте")

    return {"ok": not errors, "chars": chars, "limit": limit, "errors": errors, "warnings": warnings}


def prepare(entry: dict, *, has_photo: bool = True, root: str = registry.ROOT) -> dict:
    """Собирает публикацию: текст, ссылка, проверка.

    `status == draft` (текста ещё нет) сюда не доходит — вызывающий обязан
    отфильтровать; функция падает громко, а не отдаёт пустой пост.
    """
    text = registry.post_text(entry["slug"], entry["post"], root)
    if text is None:
        raise FileNotFoundError(
            f"нет файла текста: {registry.post_path(entry['slug'], entry['post'], root)}"
        )

    link = build_link(entry["slug"], entry["post"], entry["channel"])
    body = render(text, link)
    report = check_text(body, entry["channel"], has_photo=has_photo, template=text)
    return {"id": entry["id"], "text": body, "link": link, **report}


def summarize(data: dict) -> dict:
    """Счёт по статусам — для `--check` и для отчёта в чат."""
    counts: dict[str, int] = {}
    for entry in data["publications"]:
        status = entry.get("status", "?")
        counts[status] = counts.get(status, 0) + 1
    return counts


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="render.py",
        description="Рендер поста под площадку, проверка лимитов и статусы реестра.",
        epilog=(
            "примеры:\n"
            "  python3 tools/publish/render.py --check\n"
            "  python3 tools/publish/render.py --id kak-vybrat-kanal-prodvizheniya:post-1:telegram\n"
            "  python3 tools/publish/render.py --id voronka-prodazh-kak-postroit:post-1:telegram --mark approved --dry-run\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--registry", default=registry.REGISTRY_PATH, help="путь к registry.json")
    parser.add_argument("--id", action="append", default=[], help="id публикации (можно несколько)")
    parser.add_argument("--all", action="store_true", help="все публикации, у которых есть текст")
    parser.add_argument("--check", action="store_true", help="проверить реестр и тексты, ничего не менять")
    parser.add_argument("--mark", choices=registry.STATUSES, help="перевести публикацию в статус")
    parser.add_argument("--message-id", type=int, help="id сообщения площадки (для --mark posted)")
    parser.add_argument("--url", help="ссылка на опубликованный пост (для --mark posted)")
    parser.add_argument("--error", help="причина сбоя (обязательна для --mark failed)")
    parser.add_argument("--no-photo", action="store_true", help="считать лимит как для текста без фото")
    parser.add_argument("--dry-run", action="store_true", help="показать изменения, ничего не записывать")
    parser.add_argument("--json", action="store_true", help="вывод в JSON")
    args = parser.parse_args(argv)

    try:
        data = registry.load(args.registry)
    except (OSError, ValueError) as exc:
        print(f"ошибка чтения реестра: {exc}", file=sys.stderr)
        return 2

    errors = registry.validate(data)
    if args.check:
        counts = summarize(data)
        if args.json:
            print(json.dumps({"ok": not errors, "counts": counts, "errors": errors}, ensure_ascii=False, indent=2))
        else:
            total = len(data["publications"])
            parts = ", ".join(f"{status} {count}" for status, count in sorted(counts.items()))
            print(f"реестр: {total} публикаций ({parts}), ошибок: {len(errors)}")
            for error in errors:
                print(f"  ✗ {error}")
            if not errors:
                print("  ✓ все записи согласованы: файлы на месте, статусы известны, id уникальны")
        return 1 if errors else 0

    entries = list(data["publications"])
    if args.id:
        entries = []
        for entry_id in args.id:
            entry = registry.find(data, entry_id)
            if entry is None:
                print(f"публикации `{entry_id}` нет в реестре", file=sys.stderr)
                return 2
            entries.append(entry)
    elif not args.all:
        parser.print_help()
        return 2

    if args.all:
        entries = [e for e in entries if registry.post_text(e["slug"], e["post"]) is not None]

    if args.mark:
        if not args.id:
            print("--mark требует --id", file=sys.stderr)
            return 2
        try:
            for entry_id in args.id:
                entry = registry.set_status(
                    data,
                    entry_id,
                    args.mark,
                    message_id=args.message_id,
                    url=args.url,
                    error=args.error,
                )
                print(f"{entry_id}: -> {entry['status']}")
        except (KeyError, ValueError) as exc:
            print(f"ошибка перехода: {exc}", file=sys.stderr)
            return 1
        if args.dry_run:
            print("(dry-run) реестр не изменён")
            return 0
        registry.save(data, args.registry)
        print(f"записано: {args.registry}")
        return 0

    reports = []
    for entry in entries:
        if entry.get("status") == "draft" and registry.post_text(entry["slug"], entry["post"]) is None:
            reports.append({"id": entry["id"], "skipped": "draft без текста"})
            continue
        reports.append(prepare(entry, has_photo=not args.no_photo))

    failed = [report for report in reports if report.get("ok") is False]

    if args.json:
        print(json.dumps(reports, ensure_ascii=False, indent=2))
    else:
        for report in reports:
            if "skipped" in report:
                print(f"· {report['id']}: пропущено ({report['skipped']})")
                continue
            mark = "✓" if report["ok"] else "✗"
            limit = report["limit"] if report["limit"] is not None else "без лимита"
            print(f"{mark} {report['id']}: {report['chars']} / {limit}")
            print(f"  ссылка: {report['link']}")
            for message in report["errors"]:
                print(f"  ошибка: {message}")
            for message in report["warnings"]:
                print(f"  внимание: {message}")
            print(report["text"])
            print()

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(cli())

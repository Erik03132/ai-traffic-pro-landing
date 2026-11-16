#!/usr/bin/env python3
"""Пересобирает все обложки блога в стиле `accent` (светлый фон + плашка цвета).

Зачем отдельный файл: обложки нужны парами (og 1200×630 и квадрат 1080×1080),
и собирать их руками по одной — гарантированная рассинхронизация через месяц.
Здесь один список: слаг, короткий заголовок на обложку, рубрика.

Заголовок на обложке — не `title` статьи: в ленте читается 3–5 слов, всё
длиннее превращается в серую полосу.

Примеры:
  python3 tools/covers/make_all.py --dry-run       # показать план
  python3 tools/covers/make_all.py                 # пересобрать всё
  python3 tools/covers/make_all.py --only lending-ili-sayt
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from make_cover import DEFAULT_TEXTURE, ROOT, SIZES, build

STYLE = "accent"

OUT_DIR = ROOT / "public" / "blog"

# слаг: (заголовок на обложке, рубрика)
COVERS: dict[str, tuple[str, str]] = {
    "crm-i-erp-raznica": ("CRM и ERP: разница", "CRM И АВТОМАТИЗАЦИЯ"),
    "geo-prodvizhenie-checklist": ("GEO-продвижение: чек-лист", "SEO И GEO"),
    "kak-nachat-prodavat-na-marketpleysah": ("Старт на маркетплейсах", "E-COMMERCE"),
    "kak-schitat-okupaemost-reklamy": ("Окупаемость рекламы", "РЕКЛАМА"),
    "kak-sostavit-brif-na-prodvizhenie": ("Бриф на продвижение", "КЛИЕНТЫ"),
    "kak-vybrat-kanal-prodvizheniya": ("Как выбрать канал", "КЛИЕНТЫ"),
    "kontent-plan-dlya-sotssetey": ("Контент-план для соцсетей", "СОЦСЕТИ"),
    "lending-ili-sayt": ("Лендинг или сайт", "САЙТЫ"),
    "mediaplan-i-kontent-plan-raznica": ("Медиаплан и контент-план", "РЕКЛАМА"),
    "voronka-prodazh-kak-postroit": ("Воронка продаж", "ПРОДАЖИ"),
    "zayavki-teryayutsya": ("Заявки теряются", "CRM"),
}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Пересобрать обложки блога в стиле accent (og + square).",
        epilog="Пример: python3 tools/covers/make_all.py --only lending-ili-sayt",
    )
    ap.add_argument("--only", help="один слаг вместо всех")
    ap.add_argument("--dry-run", action="store_true", help="показать план и выйти")
    args = ap.parse_args()

    items = {args.only: COVERS[args.only]} if args.only else COVERS
    if args.only and args.only not in COVERS:
        print(f"нет такого слага: {args.only}", file=sys.stderr)
        return 2

    for slug, (title, tag) in items.items():
        for size in ("og", "square"):
            name = f"{slug}.jpg" if size == "og" else f"{slug}-square.jpg"
            out = OUT_DIR / name
            plan = f"{SIZES[size][0]}×{SIZES[size][1]}  {out.relative_to(ROOT)}  «{title}»"
            if args.dry_run:
                print("сделал бы:", plan)
                continue
            print(build(size, title, tag, "", DEFAULT_TEXTURE, out, style=STYLE))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

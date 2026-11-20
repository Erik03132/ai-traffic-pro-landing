#!/usr/bin/env python3
"""Обложки служебных страниц (og:image) тем же шаблоном, что и статьи.

Правило владельца от 17.11.2026 (docs/design/covers.md): один шаблон на всё.
Статьи уже получают `<slug>-cover.png`; здесь — страницы услуг, блог, документы.
Без og:image ссылка на услугу разворачивается в соцсетях пустой карточкой.

Примеры:
  python3 tools/publish/og_cards.py --dry-run
  python3 tools/publish/og_cards.py --only services/seo
  python3 tools/publish/og_cards.py

Выход: public/og/<имя>.png (1200x630). Пути для meta.image — '/og/<имя>.png'.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cover import build_svg, dimensions, render

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public" / "og"

# name -> (word, number, label, line1, line2)
# Номера услуг — канон из src/data/services/index.ts (порядок задаёт «01»…«07»).
CARDS: dict[str, tuple[str, str, str, str, str]] = {
    "services/leadgen": (
        "ЗАЯВКИ", "01", "НАПРАВЛЕНИЕ",
        "привлечение клиентов", "и воронка продаж",
    ),
    "services/seo": (
        "SEO", "02", "НАПРАВЛЕНИЕ",
        "видимость в Яндексе,", "Google и ИИ-ответах",
    ),
    "services/smm": (
        "SMM", "03", "НАПРАВЛЕНИЕ",
        "соцсети и Telegram", "под ключ",
    ),
    "services/advertising": (
        "РЕКЛАМА", "04", "НАПРАВЛЕНИЕ",
        "Директ, VK Реклама,", "Telegram Ads",
    ),
    "services/landing": (
        "САЙТ", "05", "НАПРАВЛЕНИЕ",
        "лендинг или сайт", "под ключ",
    ),
    "services/crm": (
        "CRM", "06", "НАПРАВЛЕНИЕ",
        "воронка, интеграции,", "порядок в заявках",
    ),
    "services/ecommerce": (
        "ТОВАР", "07", "НАПРАВЛЕНИЕ",
        "маркетплейсы", "и интернет-магазин",
    ),
    "blog": (
        "СТАТЬИ", "12", "МАТЕРИАЛОВ",
        "разборы по рекламе,", "SEO и GEO",
    ),
    "documents": (
        "ДОКУМЕНТЫ", "3", "ДОКУМЕНТА",
        "реквизиты, политика,", "согласие",
    ),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Собрать og:image для страниц услуг, блога и документов.",
        epilog=(
            "пример: python3 tools/publish/og_cards.py --only services/seo\n"
            "проверка без записи: python3 tools/publish/og_cards.py --dry-run"
        ),
    )
    parser.add_argument("--only", action="append", default=[], help="имена карточек (можно несколько)")
    parser.add_argument("--dry-run", action="store_true", help="ничего не писать, показать план")
    args = parser.parse_args(argv)

    names = args.only or list(CARDS)
    unknown = [n for n in names if n not in CARDS]
    if unknown:
        print(f"нет таких карточек: {', '.join(unknown)}", file=sys.stderr)
        return 2

    failures = 0
    for name in names:
        word, number, label, line1, line2 = CARDS[name]
        png_path = OUT / f"{name.replace('/', '-')}.png"
        if args.dry_run:
            print(f"{name}: {word} | {number} / {label} | {line1} / {line2}")
            continue

        svg = build_svg(word=word, number=number, label=label, line1=line1, line2=line2)
        png_path.parent.mkdir(parents=True, exist_ok=True)
        svg_path = png_path.with_suffix(".svg")
        svg_path.write_text(svg, encoding="utf-8")
        render(svg_path, png_path)

        size = dimensions(png_path)
        if size != (1200, 630):
            print(f"{png_path.name}: {size[0]}x{size[1]}, ожидалось 1200x630", file=sys.stderr)
            failures += 1
            continue
        print(f"{png_path.relative_to(ROOT)} — {png_path.stat().st_size // 1024} КБ")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

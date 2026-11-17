#!/usr/bin/env python3
"""Обложка статьи по шаблону docs/design/cover-template.svg.

Шаблон один на все статьи (правило от 17.11.2026, см. docs/design/covers.md):
меняются только тексты. Рендер — Chrome headless, потому что Inkscape на машине
сломан, а Дзен принимает PNG.

Примеры:
  python3 tools/publish/cover.py --slug crm-i-erp-raznica --word CRM --number ERP \\
      --label РАЗНИЦА --line1 "чем отличается учёт сделок" --line2 "от учёта ресурсов" --dry-run

  python3 tools/publish/cover.py --slug lending-ili-sayt --word САЙТ --number 2 \\
      --label СЦЕНАРИЯ --line1 "когда нужен лендинг" --line2 "а когда сайт целиком"
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "docs" / "design" / "cover-template.svg"
PUBLIC = ROOT / "public" / "blog"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WIDTH, HEIGHT = 1200, 630


def size_for(text: str, *, base: int, step: int, minimum: int) -> int:
    """Размер шрифта по длине текста, чтобы слово не вылезало за поле."""
    return max(minimum, base - max(0, len(text) - 4) * step)


def build_svg(*, word: str, number: str, label: str, line1: str, line2: str) -> str:
    template = TEMPLATE.read_text(encoding="utf-8")
    values = {
        "{{WORD}}": escape(word),
        "{{NUMBER}}": escape(number),
        "{{LABEL}}": escape(label),
        "{{LINE1}}": escape(line1),
        "{{LINE2}}": escape(line2),
        "{{WORD_SIZE}}": str(size_for(word, base=240, step=26, minimum=96)),
        "{{NUM_SIZE}}": str(size_for(number, base=210, step=30, minimum=96)),
    }
    for key, value in values.items():
        template = template.replace(key, value)
    if "{{" in template:
        raise ValueError("в шаблоне остались незаполненные плейсхолдеры")
    return template


def render(svg_path: Path, png_path: Path) -> None:
    if not Path(CHROME).exists():
        raise RuntimeError(f"не найден Chrome: {CHROME}")
    subprocess.run(
        [
            CHROME,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--window-size={WIDTH},{HEIGHT}",
            f"--screenshot={png_path}",
            f"file://{svg_path}",
        ],
        check=True,
        capture_output=True,
    )
    if not png_path.exists() or png_path.stat().st_size == 0:
        raise RuntimeError(f"PNG не создался: {png_path}")


def dimensions(png_path: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(png_path)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    width = height = 0
    for line in out.splitlines():
        if "pixelWidth" in line:
            width = int(line.split(":")[1])
        if "pixelHeight" in line:
            height = int(line.split(":")[1])
    return width, height


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Собрать обложку статьи 1200x630 (PNG) по общему шаблону.",
        epilog=(
            'пример: python3 tools/publish/cover.py --slug voronka-prodazh-kak-postroit '
            '--word ВОРОНКА --number 4 --label ЭТАПА --line1 "что считать воронкой" '
            '--line2 "и где она рвётся" --dry-run'
        ),
    )
    parser.add_argument("--slug", required=True, help="слаг статьи: <slug>-cover.svg/.png")
    parser.add_argument("--word", required=True, help="крупное слово, 3-7 знаков")
    parser.add_argument("--number", required=True, help="число или слово в цветном блоке")
    parser.add_argument("--label", required=True, help="подпись под числом, прописными")
    parser.add_argument("--line1", required=True, help="первая строка описания")
    parser.add_argument("--line2", default="", help="вторая строка описания (можно пустой)")
    parser.add_argument("--out-dir", default=str(PUBLIC), help="куда писать файлы")
    parser.add_argument("--dry-run", action="store_true", help="показать, что будет сделано")
    args = parser.parse_args(argv)

    if not TEMPLATE.exists():
        print(f"нет шаблона: {TEMPLATE}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    svg_path = out_dir / f"{args.slug}-cover.svg"
    png_path = out_dir / f"{args.slug}-cover.png"

    try:
        svg = build_svg(
            word=args.word,
            number=args.number,
            label=args.label,
            line1=args.line1,
            line2=args.line2,
        )
    except ValueError as exc:
        print(f"шаблон: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        print(f"SVG: {svg_path}")
        print(f"PNG: {png_path}")
        print(f"слово: {args.word} | блок: {args.number} / {args.label}")
        print(f"описание: {args.line1} / {args.line2}")
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    svg_path.write_text(svg, encoding="utf-8")
    render(svg_path, png_path)

    width, height = dimensions(png_path)
    if (width, height) != (WIDTH, HEIGHT):
        print(f"размер {width}x{height}, ожидался {WIDTH}x{HEIGHT}", file=sys.stderr)
        return 1
    print(f"готово: {png_path} ({width}x{height}, {png_path.stat().st_size // 1024} КБ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

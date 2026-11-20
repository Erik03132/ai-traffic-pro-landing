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
import re
import shutil
import subprocess
import sys
from pathlib import Path
from xml.sax.saxutils import escape, unescape

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "docs" / "design" / "cover-template.svg"
PUBLIC = ROOT / "public" / "blog"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WIDTH, HEIGHT = 1200, 630


def size_for(text: str, *, base: int, step: int, minimum: int) -> int:
    """Размер шрифта по длине текста, чтобы слово не вылезало за поле."""
    return max(minimum, base - max(0, len(text) - 4) * step)


# Границы полей обложки. Тераkотовый блок начинается на x=820, крупное слово
# живёт на бежевом поле левее: правило от 20.11.2026 — текст на блок не заходит.
FIELD_X = 820
PAD_X = 68
EDGE = 20
MAX_TEXT_W = FIELD_X - EDGE - PAD_X
WORD_BASELINE = 392
WORD_TOP_MIN = 150
TRACKING = -5

# Чем мерим ширину. Chrome рисует Helvetica Neue; метрики Arial Bold близки,
# плюс запас 4% — лучше чуть уменьшить кегль, чем наехать на блок.
_MEASURE_FONTS = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
)


def _metrics(size: int):
    for path in _MEASURE_FONTS:
        if Path(path).exists():
            try:
                from PIL import ImageFont

                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return None


def measure(text: str, size: int, tracking: int = TRACKING) -> int:
    """Ширина строки в пикселях с учётом разрядки."""
    if not text:
        return 0
    font = _metrics(size)
    width = font.getlength(text) if font is not None else len(text) * size * 0.72
    return round((width + tracking * (len(text) - 1)) * 1.04)


def fit_word(word: str) -> tuple[list[str], int, int]:
    """Кегль и разбивка крупного слова так, чтобы оно осталось на бежевом поле.

    Сначала пробуем одну строку: на длинных словах кегль падает. Если и на
    минимальном не влезает — режем на две строки, обе левее блока (правило
    владельца: лучше две строки, чем слово поверх тераkотовой плашки).
    Возвращает строки, кегль и базовую линию последней строки.
    """
    for size in range(240, 88, -2):
        if measure(word, size) <= MAX_TEXT_W:
            return [word], size, WORD_BASELINE

    best: tuple[list[str], int] | None = None
    for split in range(1, len(word)):
        left, right = word[:split], word[split:]
        for size in range(200, 56, -2):
            if measure(left, size) <= MAX_TEXT_W and measure(right, size) <= MAX_TEXT_W:
                if best is None or size > best[1]:
                    best = ([left, right], size)
                break

    if best is None:
        raise SystemExit(f"слово «{word}» не помещается на поле даже в две строки")

    lines, size = best
    y = WORD_BASELINE - round(size * 1.04)
    if y < WORD_TOP_MIN:
        raise SystemExit(f"слово «{word}»: две строки задевают вордмарк")
    return lines, size, y


def fit_line(text: str, *, base: int = 34, minimum: int = 22) -> int:
    """Кегль строки описания: длинная строка уменьшается, а не лезет на блок."""
    for size in range(base, minimum - 1, -1):
        if measure(text, size, tracking=-1) <= MAX_TEXT_W:
            return size
    return minimum


def build_svg(*, word: str, number: str, label: str, line1: str, line2: str) -> str:
    template = TEMPLATE.read_text(encoding="utf-8")

    lines, word_size, word_y = fit_word(word)
    if len(lines) == 1:
        tsps = escape(lines[0])
    else:
        steps = "".join(
            f'<tspan x="{PAD_X}" dy="{0 if index == 0 else "1.04em"}">{escape(line)}</tspan>'
            for index, line in enumerate(lines)
        )
        tsps = steps

    # Подпись в блоке тоже подгоняем: «ПОСТА В НЕДЕЛЮ» иначе вылезает за 380 px.
    label_size = 26
    while label_size > 16 and measure(label.upper(), label_size, tracking=6) > 340:
        label_size -= 1

    values = {
        "{{WORD_TSPS}}": tsps,
        "{{NUMBER}}": escape(number),
        "{{LABEL}}": escape(label),
        "{{LINE1}}": escape(line1),
        "{{LINE2}}": escape(line2),
        "{{WORD_SIZE}}": str(word_size),
        "{{WORD_Y}}": str(word_y),
        "{{LINE1_SIZE}}": str(fit_line(line1)),
        "{{LINE2_SIZE}}": str(fit_line(line2)),
        "{{NUM_SIZE}}": str(size_for(number, base=210, step=30, minimum=96)),
        "{{LABEL_SIZE}}": str(label_size),
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


def extract_texts(svg: str) -> dict[str, str]:
    """Достаёт тексты из уже готовой SVG: переверстать, не переписывая смысл.

    Нужно для пересборки старых обложек после правки шаблона: тексты остаются
    те же, меняются кегли и разбивка. Регулярки привязаны к цветам, а не к
    координатам, — координаты как раз и меняются.
    """
    def one(pattern: str) -> str:
        found = re.search(pattern, svg, re.S)
        return unescape(found.group(1)) if found else ""

    def many(pattern: str) -> list[str]:
        return [unescape(match) for match in re.findall(pattern, svg, re.S)]

    lines = many(r'fill="#3F3A34"[^>]*>([^<]*)</text>')
    white = many(r'fill="#FFFFFF"[^>]*>([^<]*)</text>')
    return {
        "word": one(r'fill="#171717"[^>]*>([^<]*)</text>'),
        "number": white[0] if white else "",
        "label": white[1] if len(white) > 1 else "",
        "line1": lines[0] if lines else "",
        "line2": lines[1] if len(lines) > 1 else "",
    }


def refit_all(out_dir: Path, *, dry_run: bool = False) -> int:
    """Пересобирает все `<slug>-cover.svg` в папке шаблоном с новой вёрсткой."""
    files = sorted(out_dir.glob("*-cover.svg"))
    if not files:
        print(f"в {out_dir} нет обложек *-cover.svg", file=sys.stderr)
        return 1

    failures = 0
    for svg_path in files:
        texts = extract_texts(svg_path.read_text(encoding="utf-8"))
        if not texts["word"]:
            print(f"{svg_path.name}: не нашёл крупное слово", file=sys.stderr)
            failures += 1
            continue
        try:
            svg = build_svg(**texts)
        except SystemExit as exc:
            print(f"{svg_path.name}: {exc}", file=sys.stderr)
            failures += 1
            continue

        lines, size, _ = fit_word(texts["word"])
        head = "+".join(lines)
        if dry_run:
            print(f"{svg_path.name}: {head} {size}px, строк описания 2")
            continue

        png_path = svg_path.with_suffix(".png")
        svg_path.write_text(svg, encoding="utf-8")
        render(svg_path, png_path)
        width, height = dimensions(png_path)
        if (width, height) != (WIDTH, HEIGHT):
            print(f"{png_path.name}: {width}x{height}", file=sys.stderr)
            failures += 1
            continue
        print(f"{png_path.name}: {head} {size}px — готово")

    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Собрать обложку статьи 1200x630 (PNG) по общему шаблону.",
        epilog=(
            'пример: python3 tools/publish/cover.py --slug voronka-prodazh-kak-postroit '
            '--word ВОРОНКА --number 4 --label ЭТАПА --line1 "что считать воронкой" '
            '--line2 "и где она рвётся" --dry-run\n'
            'пересобрать все обложки после правки шаблона: cover.py --refit'
        ),
    )
    parser.add_argument("--slug", help="слаг статьи: <slug>-cover.svg/.png")
    parser.add_argument("--word", help="крупное слово, 3-7 знаков")
    parser.add_argument("--number", help="число или слово в цветном блоке")
    parser.add_argument("--label", help="подпись под числом, прописными")
    parser.add_argument("--line1", help="первая строка описания")
    parser.add_argument("--line2", default="", help="вторая строка описания (можно пустой)")
    parser.add_argument("--out-dir", default=str(PUBLIC), help="куда писать файлы")
    parser.add_argument("--refit", action="store_true", help="пересобрать все <slug>-cover.svg")
    parser.add_argument("--dry-run", action="store_true", help="показать, что будет сделано")
    args = parser.parse_args(argv)

    if not TEMPLATE.exists():
        print(f"нет шаблона: {TEMPLATE}", file=sys.stderr)
        return 1

    out_dir = Path(args.out_dir)
    if args.refit:
        return refit_all(out_dir, dry_run=args.dry_run)

    missing = [
        name
        for name in ("slug", "word", "number", "label", "line1")
        if not getattr(args, name)
    ]
    if missing:
        parser.error("нужны --slug, --word, --number, --label, --line1 (или --refit)")

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

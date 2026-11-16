#!/usr/bin/env python3
"""Обложки статей блога в брендовом стиле AI-Traffic PRO.

Одна обложка = текстура (Leonardo) + типографика шрифтами сайта. Текст не
генерируется моделью: он рисуется детерминированно, поэтому серия из шести
статей выглядит одинаково и правится без пересборки картинки.

Примеры:
  python3 tools/covers/make_cover.py --slug crm-i-erp-raznica \\
      --title "CRM и ERP: в чём разница" --tag "CRM И АВТОМАТИЗАЦИЯ" --dry-run

  python3 tools/covers/make_cover.py --slug crm-i-erp-raznica \\
      --title "CRM и ERP: в чём разница" --tag "CRM И АВТОМАТИЗАЦИЯ" \\
      --size og --size square

Выход: public/blog/<slug>.jpg (1200×630, og:image) и
       public/blog/<slug>-square.jpg (1080×1080, соцсети).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    print("нужен Pillow: python3 -m pip install Pillow", file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[2]
FONTS = ROOT / "assets" / "fonts"
DEFAULT_TEXTURE = ROOT / "assets" / "covers" / "texture-paper.jpg"

# Палитра сайта (src/styles/global.css): stone-900 #18181b, terracotta-500
# #ea580c, terracotta-700 #c2410c. Раньше обложки жили на приглушённом
# кирпичном #b85c38 — он не совпадал с кнопками сайта и выглядел пыльно.
IVORY = (247, 243, 238)
INK = (24, 24, 27)
TERRACOTTA = (194, 65, 12)
ACCENT = (234, 88, 12)
MUTED = (122, 114, 105)

SIZES = {
    "og": (1200, 630),
    "square": (1080, 1080),
    "dzen": (1200, 800),
}


def font(path: Path, size: int, weight: str | None = None) -> ImageFont.FreeTypeFont:
    if not path.exists():
        raise SystemExit(f"нет шрифта: {path}")
    f = ImageFont.truetype(str(path), size)
    if weight:
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
    return f


def fit_cover(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    tw, th = size
    ratio = max(tw / img.width, th / img.height)
    resized = img.resize((round(img.width * ratio), round(img.height * ratio)), Image.LANCZOS)
    left = (resized.width - tw) // 2
    top = (resized.height - th) // 2
    return resized.crop((left, top, left + tw, top + th))


def tracked(draw: ImageDraw.ImageDraw, xy, text, fnt, fill, spacing=3):
    """Пишет текст с разрядкой. Возвращает X после последнего символа."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + spacing
    return x - spacing


def wrap(draw, text, fnt, max_width):
    words, lines, line = text.split(), [], ""
    for w in words:
        probe = f"{line} {w}".strip()
        if draw.textlength(probe, font=fnt) <= max_width or not line:
            line = probe
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    return lines


def fit_title(draw, title: str, max_width: float, max_lines: int,
              start: int, floor: int, ratio: float = 1.1, path: Path | None = None):
    """Подбирает кегль так, чтобы заголовок влез в max_lines строк.

    Кегль — главный инструмент читаемости: в ленте Telegram обложка видна
    шириной ~300 px, поэтому всё мельче 40 px исходных 1200 превращается
    в серую пыль.
    """
    size = start
    lines: list[str] = []
    while size >= floor:
        fnt = font(path or (FONTS / "PlayfairDisplay.ttf"), size)
        lines = wrap(draw, title, fnt, max_width)
        # Проверяем и длину строк: длинное слово не переносится, и без этой
        # проверки «Окупаемость» вылезает за блок и наезжает на плашку.
        widest = max((draw.textlength(line, font=fnt) for line in lines), default=0)
        if len(lines) <= max_lines and widest <= max_width:
            return fnt, lines, size
        size -= 4
    fnt = font(path or (FONTS / "PlayfairDisplay.ttf"), floor)
    return fnt, wrap(draw, title, fnt, max_width), floor


def _paper(size_name: str, title: str, tag: str, date: str, texture: Path, out: Path) -> Path:
    w, h = SIZES[size_name]
    canvas = Image.new("RGB", (w, h), IVORY)

    if texture.exists():
        tex = Image.open(texture).convert("RGB")
        tex = fit_cover(tex, (w, h)).filter(ImageFilter.GaussianBlur(0.4))
        veil = Image.new("RGB", (w, h), IVORY)
        canvas = Image.blend(tex, veil, 0.86)

    draw = ImageDraw.Draw(canvas)
    mono = font(FONTS / "JetBrainsMono.ttf", max(13, round(w * 0.0135)), "Medium")
    serif = font(FONTS / "PlayfairDisplay.ttf", 64)

    pad = round(w * 0.075)
    # Терракотовая марка и надзаголовок
    mark = max(10, round(w * 0.011))
    draw.rectangle([pad, pad, pad + mark, pad + mark], fill=TERRACOTTA)
    tracked(draw, (pad + mark + round(w * 0.014), pad + round(w * 0.0015)),
            "AI-TRAFFIC PRO", mono, INK, spacing=max(2, round(w * 0.0022)))

    # Рубрика и дата — верхний правый угол
    meta = f"{tag} · {date}"
    mw = draw.textlength(meta, font=font(FONTS / "JetBrainsMono.ttf", mono.size, "Medium"))
    if mw + pad * 2 < w:
        tracked(draw, (w - pad - mw - round(w * 0.012), pad), meta, mono, MUTED,
                spacing=max(1, round(w * 0.0012)))

    # Заголовок: подбираем кегль под 4 строки
    box_w = round(w * (0.78 if size_name != "square" else 0.82))
    box_h = round(h * (0.42 if size_name != "square" else 0.46))
    for size in range(round(w * 0.082), 26, -2):
        serif = font(FONTS / "PlayfairDisplay.ttf", size)
        lines = wrap(draw, title, serif, box_w)
        if len(lines) <= 4 and len(lines) * size * 1.12 <= box_h:
            break

    y = round(h * 0.30) if size_name != "square" else round(h * 0.34)
    for line in lines:
        draw.text((pad, y), line, font=serif, fill=INK)
        y += round(size * 1.12)

    # Нижняя линия и адрес
    rule_y = h - pad - round(h * 0.045)
    draw.line([(pad, rule_y), (pad + round(w * 0.16), rule_y)], fill=TERRACOTTA, width=max(2, round(h * 0.004)))
    site = font(FONTS / "JetBrainsMono.ttf", max(12, round(w * 0.0125)), "Medium")
    tracked(draw, (pad, rule_y + round(h * 0.013)), "AI-TRAFFIC-PRO.RU", site, MUTED,
            spacing=max(1, round(w * 0.0016)))

    return _save(canvas, out)


def _poster(size_name: str, title: str, tag: str, date: str, texture: Path, out: Path) -> Path:
    """Тёмный плакат: крупный заголовок, высокая контрастность в ленте.

    Проблема светлой обложки в Telegram: она сливается с фоном ленты, а
    мелкие надписи превращаются в пыль на превью шириной 300 px. Здесь фон
    тёмно-серый (цвет сайта), заголовок — самый крупный объект.
    """
    w, h = SIZES[size_name]
    canvas = Image.new("RGB", (w, h), INK)

    if texture.exists():
        tex = Image.open(texture).convert("RGB")
        tex = fit_cover(tex, (w, h)).filter(ImageFilter.GaussianBlur(0.4))
        canvas = Image.blend(canvas, tex, 0.06)

    draw = ImageDraw.Draw(canvas)
    pad = round(w * 0.075)
    mono = font(FONTS / "JetBrainsMono.ttf", max(17, round(w * 0.018)), "Bold")
    site_size = max(14, round(w * 0.014))

    # Марка и имя: контраст «светлое на тёмном»
    mark = max(12, round(w * 0.012))
    draw.rectangle([pad, pad, pad + mark, pad + mark], fill=TERRACOTTA)
    tracked(draw, (pad + mark + round(w * 0.015), pad + round(w * 0.003)),
            "AI-TRAFFIC PRO", mono, IVORY, spacing=max(2, round(w * 0.003)))

    # Рубрика терракотой — единственный акцент сверху
    tracked(draw, (pad, pad + round(h * 0.105)), tag.upper(), mono, ACCENT,
            spacing=max(2, round(w * 0.003)))

    # Заголовок: 3 строки, крупно
    box_w = round(w * (0.84 if size_name != "square" else 0.86))
    fnt, lines, size = fit_title(
        draw, title, box_w, 3,
        start=round(w * 0.125), floor=round(w * 0.072),
    )
    y = round(h * 0.33) if size_name != "square" else round(h * 0.36)
    for line in lines:
        draw.text((pad, y), line, font=fnt, fill=IVORY)
        y += round(size * 1.08)

    rule_y = h - pad - round(h * 0.05)
    draw.line([(pad, rule_y), (pad + round(w * 0.22), rule_y)],
              fill=TERRACOTTA, width=max(3, round(h * 0.006)))
    tracked(draw, (pad, rule_y + round(h * 0.018)), "AI-TRAFFIC-PRO.RU",
            font(FONTS / "JetBrainsMono.ttf", site_size, "Medium"), (196, 186, 176),
            spacing=max(1, round(w * 0.0018)))

    return _save(canvas, out)


def _accent(size_name: str, title: str, tag: str, date: str, texture: Path, out: Path) -> Path:
    """Светлый фон + крупный терракотовый блок: цвет сайта работает пятном.

    Деталей на обложке ровно две — имя и заголовок. Рубрика, дата и адрес
    сайта убраны: в ленте они не читаются, а место занимают. Рубрика и дата
    живут в тексте поста, адрес — в кнопке под ним.
    """
    w, h = SIZES[size_name]
    canvas = Image.new("RGB", (w, h), IVORY)

    if texture.exists():
        tex = Image.open(texture).convert("RGB")
        tex = fit_cover(tex, (w, h)).filter(ImageFilter.GaussianBlur(0.4))
        canvas = Image.blend(tex, Image.new("RGB", (w, h), IVORY), 0.90)

    draw = ImageDraw.Draw(canvas)
    pad = round(w * 0.075)

    # Блок цвета: справа у «широких» размеров, снизу у квадрата.
    if size_name == "square":
        band = [0, round(h * 0.76), w, h]
    else:
        band = [round(w * 0.70), 0, w, h]
    draw.rectangle(band, fill=ACCENT)

    # Имя и терракотовая линия под ним — единственная «марка» обложки.
    brand = font(FONTS / "JetBrainsMono.ttf", max(24, round(w * 0.028)), "Bold")
    brand_end = tracked(draw, (pad, pad), "AI-TRAFFIC-PRO", brand, INK,
                        spacing=max(2, round(w * 0.004)))
    # Линия идёт до правого края: это не подчёркивание слова, а «горизонт»,
    # отбивающий марку от заголовка. На терракотовой плашке она меняет цвет
    # на бежевый — иначе оранжевое на оранжевом исчезает.
    line_y = pad + round(brand.size * 1.42)
    line_w = max(6, round(h * 0.0085))
    band_x = band[0] if band[0] > 0 else w
    draw.line([(pad, line_y), (band_x, line_y)], fill=ACCENT, width=line_w)
    if band_x < w:
        draw.line([(band_x, line_y), (w, line_y)], fill=IVORY, width=line_w)

    # Заголовок — главный объект: 0.52 ширины оставляет воздух до плашки.
    box_w = round(w * (0.52 if size_name != "square" else 0.85))
    fnt, lines, size = fit_title(draw, title, box_w, 4,
                                 start=round(w * 0.105), floor=round(w * 0.058))
    y = round(h * 0.34) if size_name != "square" else round(h * 0.36)
    for line in lines:
        draw.text((pad, y), line, font=fnt, fill=INK)
        y += round(size * 1.1)

    return _save(canvas, out)


def _figure(size_name: str, title: str, tag: str, date: str, texture: Path, out: Path,
            figure: str = "") -> Path:
    """Тёмный фон и огромная цифра: пост про конкретный результат.

    Предмет статьи у многих материалов — число (ROMI, срок, доля). Крупная
    цифра читается даже в крошечном превью, где заголовок уже не разобрать.
    """
    w, h = SIZES[size_name]
    canvas = Image.new("RGB", (w, h), INK)

    if texture.exists():
        tex = Image.open(texture).convert("RGB")
        tex = fit_cover(tex, (w, h)).filter(ImageFilter.GaussianBlur(0.4))
        canvas = Image.blend(canvas, tex, 0.06)

    draw = ImageDraw.Draw(canvas)
    pad = round(w * 0.075)
    mono = font(FONTS / "JetBrainsMono.ttf", max(17, round(w * 0.018)), "Bold")

    mark = max(12, round(w * 0.012))
    draw.rectangle([pad, pad, pad + mark, pad + mark], fill=TERRACOTTA)
    tracked(draw, (pad + mark + round(w * 0.015), pad + round(w * 0.003)),
            "AI-TRAFFIC PRO", mono, IVORY, spacing=max(2, round(w * 0.0028)))
    tracked(draw, (pad, pad + round(h * 0.10)), tag.upper(), mono, ACCENT,
            spacing=max(2, round(w * 0.003)))

    if figure:
        # Цифра главная: кегль подбирается по ширине и высоте, не по строкам.
        number = figure.strip()
        size = round(h * 0.46)
        fnt = font(FONTS / "PlayfairDisplay.ttf", size)
        while draw.textlength(number, font=fnt) > w * 0.86 and size > 40:
            size -= 6
            fnt = font(FONTS / "PlayfairDisplay.ttf", size)
        ny = round(h * 0.47) - round(size * 0.52) if size_name != "square" else round(h * 0.52)
        draw.text((pad, ny), number, font=fnt, fill=ACCENT)

    # Заголовок — ниже цифры, короткими строками
    box_w = round(w * 0.78)
    fnt, lines, size = fit_title(draw, title, box_w, 2,
                                 start=round(w * 0.058), floor=round(w * 0.04))
    # Ставим по нижнему краю: иначе на узких размерах заголовок уходит под срез.
    block = round(len(lines) * size * 1.08)
    y = h - round(h * 0.14) - block
    for line in lines:
        draw.text((pad, y), line, font=fnt, fill=IVORY)
        y += round(size * 1.1)

    tracked(draw, (w - pad - draw.textlength("AI-TRAFFIC-PRO.RU",
                                             font=font(FONTS / "JetBrainsMono.ttf", max(13, round(w * 0.013)), "Medium")) - round(w * 0.004),
                   h - pad - round(h * 0.035)),
            "AI-TRAFFIC-PRO.RU", font(FONTS / "JetBrainsMono.ttf", max(13, round(w * 0.013)), "Medium"),
            (196, 186, 176), spacing=max(1, round(w * 0.0016)))

    return _save(canvas, out)


def _save(canvas: Image.Image, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "JPEG", quality=90, optimize=True, progressive=True)
    return out


STYLE_BUILDERS = {
    "paper": _paper,
    "poster": _poster,
    "accent": _accent,
    "figure": _figure,
}


def build(size_name: str, title: str, tag: str, date: str, texture: Path, out: Path,
          style: str = "paper", figure: str = "") -> Path:
    builder = STYLE_BUILDERS.get(style)
    if builder is None:
        raise SystemExit(f"неизвестный стиль: {style} (есть: {', '.join(STYLE_BUILDERS)})")
    if style == "figure":
        return builder(size_name, title, tag, date, texture, out, figure)
    return builder(size_name, title, tag, date, texture, out)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Обложки статей в брендовом стиле (текстура + типографика сайта)",
        epilog="Пример: python3 tools/covers/make_cover.py --slug lending-ili-sayt "
               "--title 'Лендинг или сайт' --tag 'САЙТЫ' --size og",
    )
    ap.add_argument("--slug", required=True, help="slug статьи, задаёт имя файла")
    ap.add_argument("--title", required=True, help="заголовок на обложке (короткий)")
    ap.add_argument("--tag", default="БЛОГ", help="рубрика, капсом")
    ap.add_argument("--date", default="", help="дата для угла, напр. 09.11.2026")
    ap.add_argument("--texture", default=str(DEFAULT_TEXTURE), help="фоновая текстура")
    ap.add_argument("--style", default="paper", choices=sorted(STYLE_BUILDERS),
                    help="paper (светлая) | poster (тёмная) | accent (пятно цвета) | figure (крупная цифра)")
    ap.add_argument("--figure", default="", help="цифра для стиля figure, напр. 215%%")
    ap.add_argument("--size", action="append", choices=sorted(SIZES), help="og | square | dzen (можно несколько)")
    ap.add_argument("--out-dir", default=str(ROOT / "public" / "blog"), help="куда положить файлы")
    ap.add_argument("--dry-run", action="store_true", help="показать план и выйти")
    args = ap.parse_args()

    sizes = args.size or ["og"]
    out_dir = Path(args.out_dir)
    plan = []
    for s in sizes:
        suffix = "" if s == "og" else f"-{s}"
        plan.append((s, out_dir / f"{args.slug}{suffix}.jpg"))

    if args.dry_run:
        for s, p in plan:
            print(f"{s:7} {SIZES[s][0]}×{SIZES[s][1]} → {p}")
        print(f"текстура: {args.texture} (есть={Path(args.texture).exists()})")
        return 0

    for s, p in plan:
        print(build(s, args.title, args.tag, args.date, Path(args.texture), p,
                    style=args.style, figure=args.figure))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

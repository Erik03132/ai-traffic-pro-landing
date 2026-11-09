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

IVORY = (244, 239, 232)
INK = (43, 41, 38)
TERRACOTTA = (184, 92, 56)
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
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + spacing


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


def build(size_name: str, title: str, tag: str, date: str, texture: Path, out: Path) -> Path:
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

    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, "JPEG", quality=90, optimize=True, progressive=True)
    return out


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
        print(build(s, args.title, args.tag, args.date, Path(args.texture), p))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

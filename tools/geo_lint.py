#!/usr/bin/env python3
"""
GEO-скоринг статьи: даёт 0–100 и список конкретных правок.

Зачем: страницу цитируют в ответах ИИ, когда в ней есть прямой ответ,
таблица сравнения, числа, названные системы и источники. На глаз это не
проверить — «вроде нормально» и «есть чем цитировать» выглядят одинаково.
Линтер переводит приёмку в цифру.

Что читает: готовый HTML по URL (`--url`), локальный файл (`--file`) или
весь блог из `sitemap.xml` (`--sitemap`). Читает то, что реально видят
поисковик и AI-бот, а не исходник.

8 блоков (сумма 100):
  1. Ответ в начале          — 12  сколько слов до первого H2
  2. Объём                   — 10  слов в теле статьи
  3. Таблица сравнения       — 14  наличие <table>
  4. Цифры с единицами       — 14  проценты, сроки, рубли, штуки
  5. Названные системы       — 14  CRM/ERP/продукты по именам
  6. Внешние источники       — 10  ссылки на первоисточники
  7. Структура и перелинковка— 12  H3 внутри H2 + ссылки в тексте
  8. Разметка и автор        — 14  BlogPosting / FAQPage / человек-автор

Отдельно, без баллов: robots.txt (пропускает ли AI-ботов), llms.txt,
canonical, длины title/description.

Примеры:
  python3 tools/geo_lint.py --url https://ai-traffic-pro.ru/blog/crm-i-erp-raznica/
  python3 tools/geo_lint.py --url URL --query "crm и erp разница"
  python3 tools/geo_lint.py --file dist/blog/crm-i-erp-raznica/index.html
  python3 tools/geo_lint.py --sitemap https://ai-traffic-pro.ru/sitemap.xml --limit 40
  python3 tools/geo_lint.py --sitemap URL --report docs/seo/geo-lint.json --min-score 60

Коды выхода: 0 — успех, 1 — балл ниже --min-score, 2 — ошибка входа.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser

UA = "Mozilla/5.0 (compatible; geo-lint/1.0)"
TIMEOUT = 20

# Названные системы: без имён страница не может стать источником ответа
# «что выбрать» — модель возьмёт ту, где продукты названы.
ENTITIES = [
    "1с", "1c", "битрикс24", "bitrix24", "bitrix", "amocrm", "амосрм", "salesforce",
    "sap", "oracle", "odoo", "hubspot", "dynamics", "мойсклад", "retailcrm",
    "yclients", "мегаплан", "megaplan", "планфикс", "zoho", "erpnext",
    "класс365", "аспро", "sbercrm", "битрикс", "коммерсантъ", "нетология",
    # ИИ-поиск и аналитика: без имён статья про GEO не может быть источником
    "ai overviews", "ai mode", "google ai", "яндекс нейро", "нейро", "алиса",
    "chatgpt", "perplexity", "gemini", "copilot", "ahrefs", "semrush",
    "search console", "вебмастер", "serpstat", "similarweb",
]

# Соцсети и мессенджеры не считаем источниками — это не первоисточник.
SOCIAL = ("vk.com", "t.me", "telegram", "youtube", "youtu.be", "facebook",
          "instagram", "twitter", "x.com", "wa.me", "whatsapp", "linkedin",
          "dzen.ru", "zen.yandex", "rutube", "tiktok", "pinterest")

COMPARATIVE = re.compile(
    r"разниц|отлича|сравн|vs|\bили\b|что выбрать|что лучше|какой выбрать|"
    r"чем.*лучше|difference|versus", re.I)

NUM_UNITS = re.compile(
    r"\b\d+(?:[.,]\d+)?\s*(?:%|руб|₽|тыс|млн|млрд|дн[яей]*|недел\w*|мес\w*|"
    r"год\w*|лет|час\w*|минут\w*|сотрудник\w*|пользовател\w*|заявок|заявк\w*|"
    r"этап\w*|шаг\w*|клиент\w*|компан\w*)", re.I)

BLOCKS = [
    ("answer", "Ответ в начале", 12),
    ("depth", "Объём", 10),
    ("table", "Таблица сравнения", 14),
    ("numbers", "Цифры с единицами", 14),
    ("entities", "Названные системы", 14),
    ("sources", "Внешние источники", 10),
    ("structure", "Структура и перелинковка", 12),
    ("schema", "Разметка и автор", 14),
]


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.read().decode(charset, errors="replace")


def plain(html: str) -> str:
    h = re.sub(r"<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", h))


def words(text: str) -> int:
    return len(re.findall(r"[A-Za-zА-Яа-яЁё0-9]+", text))


class Page(HTMLParser):
    """Собирает заголовки, ссылки, таблицы и текст внутри <article>/<main>."""

    SKIP = {"script", "style", "noscript", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.icon = 0
        self.art = 0
        self.main = 0
        self.buf_art: list[str] = []
        self.buf_main: list[str] = []
        self.headings: list[tuple[int, str, bool]] = []
        self.links: list[tuple[str, str, bool]] = []
        self.cur_h: tuple[int, list[str]] | None = None
        self.cur_a: tuple[str, list[str]] | None = None
        self.tables = 0
        self.imgs = 0
        self.title = ""
        self.meta: dict[str, str] = {}
        self.ldjson: list[str] = []
        self.in_ld = False
        self.canonical = ""
        self.saw_article = False
        self.first_h2_pos: int | None = None
        self.first_h2_pos_all: int | None = None
        self.buf_all: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script" and "ld+json" in (a.get("type") or ""):
            self.in_ld = True
            self.ldjson.append("")
            self.skip += 1
        elif tag in self.SKIP:
            self.skip += 1
        elif self.is_icon(tag, a):
            # Внутри иконки лежит имя лигатуры (check_circle, arrow_forward):
            # это оформление, а не текст. Без пропуска оно приклеивается к
            # следующему слову и ломает границы («check_circleretailcrm»).
            self.icon += 1
        elif tag == "article":
            self.art += 1
            self.saw_article = True
        elif tag == "main":
            self.main += 1
        elif tag == "h1" or tag == "h2" or tag == "h3":
            self.cur_h = (int(tag[1]), [])
            if tag == "h2" and self.first_h2_pos is None and self.in_region():
                self.first_h2_pos = words(" ".join(self.region_buf()))
            if tag == "h2" and self.first_h2_pos_all is None:
                self.first_h2_pos_all = words(" ".join(self.buf_all))
        elif tag == "a" and a.get("href"):
            self.cur_a = (a["href"].strip(), [])
        elif tag == "table":
            self.tables += 1
        elif tag == "img":
            self.imgs += 1
        elif tag == "title":
            self.cur_h = (0, [])
        elif tag == "meta":
            if a.get("name"):
                self.meta[a["name"].lower()] = a.get("content", "")
            if a.get("property"):
                self.meta[a["property"].lower()] = a.get("content", "")
        elif tag == "link" and "canonical" in (a.get("rel") or ""):
            self.canonical = a.get("href", "")

    def is_icon(self, tag: str, a: dict) -> bool:
        """Декоративная иконка: её содержимое не считается содержимым страницы."""
        cls = a.get("class") or ""
        return tag in ("span", "i", "em") and (
            "material-symbols" in cls or "material-icons" in cls
        )

    def handle_endtag(self, tag):
        if tag in ("span", "i", "em") and self.icon:
            self.icon -= 1
            return
        if tag in self.SKIP and self.skip:
            self.skip -= 1
            if tag == "script":
                self.in_ld = False
        elif tag == "article":
            self.art = max(0, self.art - 1)
        elif tag == "main":
            self.main = max(0, self.main - 1)
        elif tag in ("h1", "h2", "h3", "title") and self.cur_h:
            lvl, parts = self.cur_h
            text = " ".join("".join(parts).split())
            if lvl == 0:
                self.title = text
            elif text:
                self.headings.append((lvl, text, self.in_region()))
            self.cur_h = None
        elif tag == "a" and self.cur_a:
            href, parts = self.cur_a
            self.links.append((href, " ".join("".join(parts).split()), self.in_region()))
            self.cur_a = None
        elif tag == "script":
            self.in_ld = False

    def handle_data(self, data):
        if self.in_ld and self.ldjson:
            self.ldjson[-1] += data
            return
        if self.skip or self.icon:
            return
        if self.cur_h is not None:
            self.cur_h[1].append(data)
        if self.cur_a is not None:
            self.cur_a[1].append(data)
        if self.in_region():
            self.region_buf().append(data)
        self.buf_all.append(data)

    def in_region(self) -> bool:
        return self.art > 0 or (self.main > 0 and not self.saw_article)

    def region_buf(self) -> list[str]:
        if self.art > 0:
            return self.buf_art
        if self.main > 0 and not self.saw_article:
            return self.buf_main
        return self.buf_art

    def region_text(self) -> str:
        src = self.buf_art if self.saw_article else self.buf_main
        return " ".join("".join(src).split())

    def region_links(self):
        return [x for x in self.links if x[2]]


def analyse(html: str, query: str = "") -> dict:
    p = Page()
    p.feed(html)
    text = p.region_text() or plain(html)
    wc = words(text)
    comparative = bool(query and COMPARATIVE.search(query))

    arts = [h for h in p.headings if h[2]]
    if not p.saw_article and not p.buf_main:
        arts = p.headings  # страница без <article>/<main>: считаем весь документ
    h2 = [h for h in arts if h[0] == 2]
    h3 = [h for h in arts if h[0] == 3]
    before = p.first_h2_pos
    if before is None:
        before = p.first_h2_pos_all if h2 else wc
    first_h2 = h2[0][1].lower() if h2 else ""

    nums = len(set(NUM_UNITS.findall(text)))
    ents = sorted({e for e in ENTITIES if re.search(rf"(?<![а-яa-z]){re.escape(e)}(?![а-яa-z])", text.lower())})

    rlinks = p.region_links()
    if not p.saw_article and not p.buf_main:
        rlinks = p.links
    internal, external = [], []
    for href, anchor, _ in rlinks:
        if href.startswith("#") or href.startswith("mailto:"):
            continue
        if href.startswith("/") or "ai-traffic-pro.ru" in href:
            internal.append((href, anchor))
        elif not any(s in href for s in SOCIAL):
            external.append((href, anchor))

    ld = " ".join(p.ldjson).lower()
    has_post = bool(re.search(r'"blogposting"|"article"|"newsarticle"|"techarticle"', ld))
    has_faq = '"faqpage"' in ld
    person = bool(re.search(r'"author"\s*:\s*\{[^}]*"@type"\s*:\s*"(person|people)"', ld)) or \
        bool(p.meta.get("author")) and p.meta.get("author", "").lower() not in ("", "admin")

    s = {}

    # 1. Ответ в начале
    if before <= 120:
        s["answer"] = 12
    elif before <= 200:
        s["answer"] = 9
    elif before <= 320:
        s["answer"] = 5
    else:
        s["answer"] = 0
    if s["answer"] and re.search(r"коротко|итог|простыми словами|в двух словах|ответ", first_h2):
        s["answer"] = min(12, s["answer"] + 0)

    # 2. Объём
    s["depth"] = 10 if wc >= 1500 else 8 if wc >= 1200 else 5 if wc >= 900 else 2 if wc >= 600 else 0

    # 3. Таблица
    s["table"] = 14 if p.tables else 0

    # 4. Цифры
    s["numbers"] = 14 if nums >= 5 else 10 if nums >= 3 else 5 if nums >= 1 else 0

    # 5. Сущности
    n = len(ents)
    s["entities"] = 14 if n >= 5 else 9 if n >= 3 else 4 if n >= 1 else 0

    # 6. Источники
    m = len(external)
    s["sources"] = 10 if m >= 3 else 8 if m >= 2 else 4 if m >= 1 else 0

    # 7. Структура и перелинковка
    s["structure"] = (6 if len(h3) >= 3 and len(h2) >= 4 else 3 if len(h2) >= 4 else 0) + \
                     (6 if len(internal) >= 2 else 3 if len(internal) == 1 else 0)

    # 8. Разметка и автор
    s["schema"] = (5 if has_post else 0) + (4 if has_faq else 0) + (5 if person else 0)

    fixes = []
    if s["answer"] < 9:
        fixes.append(f"Сжать вступление: до первого H2 сейчас {before} слов, нужно ≤120. Ответ — в первом абзаце.")
    if s["depth"] < 8:
        fixes.append(f"Объём {wc} слов — мало для конкуренции. Довести до 1200–1800, не разбавляя водой.")
    if not p.tables:
        tag = ("КРИТИЧНО (сравнительный запрос) — добавить " if comparative else "Добавить ")
        fixes.append(f"{tag}настоящую <table> сравнения (8–10 строк), а не список с галочками.")
    if s["numbers"] < 10:
        fixes.append(f"Чисел с единицами {nums} (нужно ≥3): сроки внедрения, цены лицензий, проценты провалов.")
    if n < 3:
        fixes.append("Назвать системы по именам с привязкой к ситуации: 1С, Битрикс24, amoCRM, Odoo, SAP.")
    if m < 2:
        fixes.append(f"Внешних источников {m} (нужно ≥2): первоисточники по теме, ссылка в том же предложении.")
    if len(h3) < 3:
        fixes.append(f"H3 внутри H2: сейчас {len(h3)}. Без подразделов страницу не выдёргивают по пассажу.")
    if len(internal) < 2:
        fixes.append(f"Контекстных внутренних ссылок {len(internal)} (нужно ≥2) — в тело текста, а не карточками.")
    if not has_post:
        fixes.append("Нет разметки BlogPosting/Article — добавить JSON-LD.")
    if not has_faq:
        fixes.append("Нет FAQPage — добавить 3–5 вопросов с короткими ответами.")
    if not person:
        fixes.append("Автор — организация. Указать человека с одной строкой опыта: это E-E-A-T и доверие ИИ.")

    total = sum(s.values())
    return {
        "words": wc,
        "words_before_first_h2": before,
        "tables": p.tables,
        "images": p.imgs,
        "numbers": nums,
        "entities": ents,
        "external_links": m,
        "internal_links": len(internal),
        "h2": len(h2),
        "h3": len(h3),
        "comparative": comparative,
        "score": total,
        "blocks": {k: {"label": lbl, "score": s[k], "max": mx} for k, lbl, mx in BLOCKS},
        "fixes": fixes,
        "meta": {
            "title": p.title,
            "title_len": len(p.title),
            "description_len": len(p.meta.get("description", "")),
            "canonical": p.canonical,
            "author": p.meta.get("author", ""),
            "has_person": person,
            "has_blogposting": has_post,
            "has_faqpage": has_faq,
        },
    }


def site_info(url: str) -> dict:
    root = re.match(r"(https?://[^/]+)", url)
    if not root:
        return {}
    base = root.group(1)
    out = {}
    try:
        rb = fetch(base + "/robots.txt")
        out["robots_ai_bots"] = "не блокирует" if "disallow: /" not in rb.lower() or \
            not re.search(r"user-agent:\s*(gptbot|perplexitybot|claudebot)", rb, re.I) else "проверить вручную"
        out["robots_declares_ai"] = bool(re.search(r"(gptbot|perplexitybot|claudebot|yandexgpt)", rb, re.I))
    except Exception:
        out["robots_ai_bots"] = "нет/недоступен"
    try:
        lt = fetch(base + "/llms.txt")
        out["llms_txt"] = f"есть, {len(lt)} символов"
    except Exception:
        out["llms_txt"] = "нет"
    return out


def bar(score: int, mx: int, width: int = 12) -> str:
    filled = round(score / mx * width) if mx else 0
    return "█" * filled + "·" * (width - filled)


def show(url: str, res: dict, info: dict, verbose: bool = True) -> None:
    print(f"\n{url}")
    print(f"  ОЦЕНКА: {res['score']}/100   "
          f"({res['words']} слов, ответ через {res['words_before_first_h2']} сл., "
          f"таблиц {res['tables']}, H2/H3 {res['h2']}/{res['h3']})")
    if verbose:
        for k, lbl, mx in BLOCKS:
            b = res["blocks"][k]
            print(f"    {bar(b['score'], mx)} {b['score']:>2}/{mx}  {lbl}")
        if info:
            print(f"  Сайт: llms.txt — {info.get('llms_txt')}, "
                  f"robots AI-боты — {info.get('robots_ai_bots')}, "
                  f"явно объявлены — {'да' if info.get('robots_declares_ai') else 'нет'}")
        if res["entities"]:
            print(f"  Системы: {', '.join(res['entities'])}")
        if res["fixes"]:
            print("  Что исправить:")
            for i, f in enumerate(res["fixes"], 1):
                print(f"    {i}. {f}")


def sitemap_urls(sm: str) -> list[str]:
    xml = fetch(sm)
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml)
    if not locs:
        return []
    # вложенные sitemap-индексы
    if all(l.endswith(".xml") for l in locs[:3]):
        out = []
        for child in locs[:10]:
            try:
                out += re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", fetch(child))
            except Exception:
                pass
        locs = out or locs
    return [l for l in locs if "/blog/" in l]


def main() -> int:
    ap = argparse.ArgumentParser(
        description="GEO-скоринг статьи: 0–100 и список правок.",
        epilog="Примеры:\n"
               "  python3 tools/geo_lint.py --url https://ai-traffic-pro.ru/blog/crm-i-erp-raznica/\n"
               "  python3 tools/geo_lint.py --url URL --query \"crm и erp разница\"\n"
               "  python3 tools/geo_lint.py --sitemap https://ai-traffic-pro.ru/sitemap.xml --limit 40\n"
               "  python3 tools/geo_lint.py --sitemap URL --report docs/seo/geo-lint.json --min-score 60",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--url", help="адрес одной статьи")
    src.add_argument("--file", help="локальный HTML-файл")
    src.add_argument("--sitemap", help="sitemap.xml: проверятся все URL с /blog/")
    ap.add_argument("--query", default="", help="целевой запрос: включает требование таблицы для сравнительных")
    ap.add_argument("--limit", type=int, default=40, help="сколько URL из sitemap брать (по умолчанию 40)")
    ap.add_argument("--min-score", type=int, default=0, help="порог приёмки: ниже — код выхода 1")
    ap.add_argument("--report", help="записать JSON-отчёт по этому пути")
    ap.add_argument("--dry-run", action="store_true", help="посчитать и показать, ничего не записывать")
    ap.add_argument("--quiet", action="store_true", help="только итоговая строка на каждый URL")
    ap.add_argument("--json", action="store_true", help="вывести JSON в stdout")
    args = ap.parse_args()

    try:
        if args.file:
            html = open(args.file, encoding="utf-8", errors="replace").read()
            targets = [(args.file, html)]
        elif args.url:
            targets = [(args.url, fetch(args.url))]
        else:
            urls = sitemap_urls(args.sitemap)[: args.limit]
            if not urls:
                print(f"geo-lint: в {args.sitemap} не найдено URL с /blog/", file=sys.stderr)
                return 2
            with ThreadPoolExecutor(max_workers=6) as ex:
                targets = list(ex.map(lambda u: (u, fetch(u)), urls))
    except urllib.error.URLError as e:
        print(f"geo-lint: не удалось загрузить: {e}", file=sys.stderr)
        return 2
    except FileNotFoundError:
        print(f"geo-lint: файл не найден: {args.file}", file=sys.stderr)
        return 2

    info = site_info(args.url) if args.url else {}
    results = []
    for url, html in targets:
        res = analyse(html, args.query)
        results.append({"url": url, **res})
        if not args.json:
            show(url, res, info, verbose=not args.quiet)

    if args.sitemap and not args.json:
        scores = sorted(r["score"] for r in results)
        avg = sum(scores) / len(scores)
        print(f"\nИТОГО: {len(scores)} страниц, средний балл {avg:.0f}, "
              f"медиана {scores[len(scores)//2]}, ниже 50 — {sum(1 for s in scores if s < 50)}")
        print("Худшие:")
        for r in sorted(results, key=lambda x: x["score"])[:5]:
            print(f"  {r['score']:>3}  {r['url']}")

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "query": args.query,
        "site": info,
        "results": results,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    if args.report and not args.dry_run:
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"\nОтчёт: {args.report}", file=sys.stderr)

    worst = min(r["score"] for r in results)
    return 1 if args.min_score and worst < args.min_score else 0


if __name__ == "__main__":
    sys.exit(main())

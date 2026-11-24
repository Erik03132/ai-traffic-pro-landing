#!/usr/bin/env python3
"""
Карточки конкурентов по GEO-сигналам: что реально видит AI-бот на их сайте.

Зачем: «конкурент сильнее в GEO» — это мнение, пока не собраны факты.
Карточка отвечает на 6 вопросов, каждый из которых проверяется машинно:
  1. оффер и цены на первой странице (публичные цифры, а не оценка);
  2. llms.txt — есть ли и насколько содержательный (строк, факты, цены);
  3. robots.txt — названы ли AI-боты по имени;
  4. Schema.org — какие типы размечены, есть ли FAQPage/Offer/Person;
  5. FAQ и автор на странице (что цитируют модели);
  6. чем цепляют в первом экране (H1 и H2).

Что НЕ делает: не измеряет долю голоса в ответах LLM. Для этого нужен
прогон промптов в ChatGPT / Perplexity / Яндекс Нейро — отдельная процедура
(docs/seo/ai-visibility-*.md), потому что выдача моделей недетерминирована.

Примеры:
  python3 tools/competitor_scan.py --domains vzlet.agency,vverh.digital --out docs/seo/cards.md
  python3 tools/competitor_scan.py --domains trafficpro.agency --dry-run
  python3 tools/competitor_scan.py --help

Правило: домены передаются флагом, вывод — в файл, повторный запуск
перезаписывает результат и безопасен.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import date

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")
AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "anthropic-ai",
           "PerplexityBot", "Google-Extended", "YandexAdditional", "Amazonbot", "CCBot"]
PRICE_RE = re.compile(r"(?:от\s*)?(\d[\d\s\u00a0]{2,7})\s*(?:₽|руб|р\.|рублей)", re.I)


def fetch(url: str, timeout: int = 12) -> tuple[int | None, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru,en;q=0.8"})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read()
            if r.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return r.status, raw.decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:  # noqa: BLE001 — сеть: сообщаем класс ошибки, не молчим
        return None, f"ERR:{type(e).__name__}"


def ld_types(html: str) -> list[str]:
    found: list[str] = []
    for m in re.finditer(r"(?s)<script[^>]+application/ld\+json[^>]*>(.*?)</script>", html):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:  # noqa: BLE001
            found.append("PARSE_FAIL")
            continue
        stack = [data]
        while stack:
            cur = stack.pop()
            if isinstance(cur, dict):
                t = cur.get("@type")
                if isinstance(t, str):
                    found.append(t)
                elif isinstance(t, list):
                    found.extend(x for x in t if isinstance(x, str))
                stack.extend(cur.values())
            elif isinstance(cur, list):
                stack.extend(cur)
    return sorted(set(found))


def headings(html: str, limit: int = 8) -> list[str]:
    out = []
    for lvl, body in re.findall(r"(?is)<h([12])[^>]*>(.*?)</h\1>", html):
        text = re.sub(r"\s+", " ", re.sub(r"(?s)<[^>]+>", "", body)).strip()
        if text:
            out.append(text[:110])
    return out[:limit]


def scan(domain: str) -> dict:
    status, html = fetch(f"https://{domain}/")
    rec: dict = {"domain": domain, "status": status}
    if not html or html.startswith("ERR:"):
        rec["error"] = html or "empty response"
        return rec

    title = re.search(r"(?is)<title[^>]*>(.*?)</title>", html)
    desc = re.search(r'(?is)<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']', html)
    rec["title"] = re.sub(r"\s+", " ", title.group(1)).strip()[:180] if title else ""
    rec["description"] = re.sub(r"\s+", " ", desc.group(1)).strip()[:260] if desc else ""
    rec["schema"] = ld_types(html)
    rec["faq_schema"] = "FAQPage" in rec["schema"]
    rec["offer_schema"] = "Offer" in rec["schema"] or "OfferCatalog" in rec["schema"]
    rec["author_schema"] = "Person" in rec["schema"]
    prices = [p.strip() for p in PRICE_RE.findall(html)]
    rec["prices"] = sorted(set(prices), key=lambda x: x)[:10]
    rec["heads"] = headings(html)
    rec["lang_ua"] = bool(re.search(r"(?i)\b(ми|ваш|послуги|кейси)\b", html[:20000]))
    rec["ai_mentions"] = len(re.findall(r"(?i)нейросет|chatgpt|perplexity|яндекс\s*нейро|llm|\bgeo\b|\baeo\b", html))

    r_status, robots = fetch(f"https://{domain}/robots.txt")
    rec["robots_status"] = r_status
    rec["ai_bots"] = [b for b in AI_BOTS if b.lower() in robots.lower()]
    rec["blocks_all"] = bool(re.search(r"(?im)^user-agent:\s*\*", robots)) and "disallow: /" not in robots.lower()

    l_status, llms = fetch(f"https://{domain}/llms.txt")
    rec["llms_status"] = l_status
    rec["llms_lines"] = len([l for l in llms.splitlines() if l.strip()]) if l_status == 200 else 0
    rec["llms_prices"] = bool(PRICE_RE.search(llms)) if l_status == 200 else False
    rec["llms_head"] = [l.strip() for l in llms.splitlines() if l.strip()][1:4] if l_status == 200 else []
    return rec


def yn(flag: bool) -> str:
    return "да" if flag else "—"


def card(rec: dict) -> str:
    d = rec["domain"]
    lines = [f"## {d}", ""]
    if rec.get("error"):
        return "\n".join(lines + [f"**Не просканирован:** `{rec['error']}` (HTTP {rec['status']})", ""])
    lines += [
        f"- **HTTP** {rec['status']} · title: {rec['title'] or '—'}",
        f"- **Description:** {rec['description'] or '—'}",
        f"- **llms.txt:** {yn(rec['llms_status'] == 200)}"
        + (f" ({rec['llms_lines']} строк, цены внутри: {yn(rec['llms_prices'])})" if rec["llms_status"] == 200 else ""),
        f"- **AI-боты в robots.txt:** {', '.join(rec['ai_bots']) if rec['ai_bots'] else 'не названы'}"
        + (" (User-agent: * Allow: /)" if rec["blocks_all"] else ""),
        f"- **Schema:** {', '.join(rec['schema']) if rec['schema'] else 'нет разметки'}",
        f"- **Пробелы разметки:** FAQPage {yn(rec['faq_schema'])} · Offer {yn(rec['offer_schema'])} · Person {yn(rec['author_schema'])}",
        f"- **Цены в HTML:** {', '.join(rec['prices']) if rec['prices'] else 'не опубликованы'}",
        f"- **Упоминаний AI/GEO в коде страницы:** {rec['ai_mentions']}",
        f"- **Первый экран:** {' · '.join(rec['heads'][:4]) if rec['heads'] else '—'}",
        "",
    ]
    return "\n".join(lines)


def table(records: list[dict]) -> str:
    head = ("| Домен | llms.txt | AI-боты в robots | Schema-типов | FAQPage | Цены в HTML "
            "| Кто это (проверить глазами) |\n|---|---|---|---|---|---|---|")
    rows = []
    for r in records:
        if r.get("error"):
            rows.append(f"| `{r['domain']}` | ошибка | — | — | — | — | `{r['error']}` |")
            continue
        rows.append(
            f"| `{r['domain']}` | {yn(r['llms_status'] == 200)} ({r['llms_lines']} стр.) "
            f"| {len(r['ai_bots'])} | {len(r['schema'])} | {yn(r['faq_schema'])} "
            f"| {', '.join(r['prices'][:3]) if r['prices'] else '—'} | — |"
        )
    return "\n".join([head] + rows)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Карточки конкурентов по машинно-проверяемым GEO-сигналам.",
        epilog="Пример: python3 tools/competitor_scan.py --domains vzlet.agency,vverh.digital "
               "--out docs/seo/competitor-cards.md",
    )
    ap.add_argument("--domains", required=True, help="через запятую, без https:// — напр. vzlet.agency,nevsky.agency")
    ap.add_argument("--out", help="куда писать markdown; без флага — только stdout")
    ap.add_argument("--label", default="", help="подпись замера, напр. 'конкуренты ai-traffic-pro.ru'")
    ap.add_argument("--dry-run", action="store_true", help="показать домены и выйти, ничего не запрашивая")
    args = ap.parse_args()

    domains = [d.strip().removeprefix("https://").removeprefix("http://").strip("/")
               for d in args.domains.split(",") if d.strip()]
    if not domains:
        print("нет доменов в --domains", file=sys.stderr)
        return 2
    if args.dry_run:
        print("Будут просканированы: " + ", ".join(domains))
        print(f"Вывод: {args.out or 'stdout'}")
        return 0

    records = [scan(d) for d in domains]
    failed = [r["domain"] for r in records if r.get("error")]
    for r in records:
        mark = "OK " if not r.get("error") else "FAIL"
        print(f"[{mark}] {r['domain']}", file=sys.stderr)

    md = [
        f"# Карточки конкурентов: {args.label or ', '.join(domains)}",
        "",
        f"Замер: {date.today().isoformat()}. Источник данных — публичный HTML, robots.txt "
        "и llms.txt на момент запуска. Цифры трат и воронки конкурентов здесь не считаются: "
        "их нет в открытом доступе, оценка была бы выдумкой.",
        "",
        "## Сводка",
        "",
        table(records),
        "",
        "## Карточки",
        "",
    ] + [card(r) for r in records]

    text = "\n".join(md)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"Записано: {args.out}")
    else:
        print(text)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

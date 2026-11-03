#!/usr/bin/env python3
"""
Проверка покрытия фраз кластера в собранной странице услуги.

Зачем: гипотеза из arXiv:2610.15033 — страницу цитируют, когда её заголовок
и абзацы совпадают по смыслу с формулировками вопросов. Значит приёмку
«переписали под фразы» надо измерять, а не обсуждать на глаз.

Что читает: собранный HTML (`dist/services/<slug>/index.html`) — то, что
реально видят поисковик и AI-бот, а не исходник.

Метрики:
  * точное вхождение — фраза кластера есть в тексте дословно;
  * по словам — все слова фразы нашлись в тексте с учётом окончаний
    (сравнение по первым 5 буквам: «продвижен» = «продвижение/продвижением»).

Порог приёмки ATP-G1: ≥5 коммерческих фраз кластера покрыты.

Примеры:
  python3 tools/geo_match.py --slug seo
  python3 tools/geo_match.py --slug seo --title "..." --subtitle "..."
  python3 tools/geo_match.py --slug seo --dist dist --top 15
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PREFIX = 5          # сколько первых букв считать совпадением слова
THRESHOLD = 5       # порог ATP-G1


def norm(text: str) -> str:
    text = (text or "").lower().replace("ё", "е")
    text = re.sub(r"[^a-zа-я0-9]+", " ", text)
    return " ".join(text.split())


def words(text: str) -> list[str]:
    return norm(text).split()


def same_word(a: str, b: str) -> bool:
    if a == b:
        return True
    return len(a) >= PREFIX and len(b) >= PREFIX and a[:PREFIX] == b[:PREFIX]


class PageText(HTMLParser):
    """Достаёт title, H1 и первый абзац после H1."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.h1 = ""
        self.first_p = ""
        self._in_title = False
        self._in_h1 = False
        self._h1_done = False
        self._in_p = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag == "title":
            self._in_title = True
        elif tag == "h1" and not self._h1_done:
            self._in_h1 = True
        elif tag == "p" and self._h1_done and not self.first_p:
            self._in_p = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "h1" and self._in_h1:
            self._in_h1 = False
            self._h1_done = True
        elif tag == "p" and self._in_p:
            self._in_p = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif self._in_h1:
            self.h1 += data
        elif self._in_p:
            self.first_p += data


def load_cluster(semantics_path: str, slug: str) -> dict:
    with open(semantics_path, encoding="utf-8") as fh:
        data = json.load(fh)
    for cluster in data.get("clusters", []):
        if cluster.get("id") == slug:
            return cluster
    raise SystemExit(f"кластер «{slug}» не найден в {semantics_path}")


def coverage(text: str, queries: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
    """Возвращает (дословные, по словам, не покрытые)."""
    flat = norm(text)
    haystack = words(text)
    exact, fuzzy, missing = [], [], []
    for item in queries:
        phrase = norm(item["query"])
        if not phrase:
            continue
        if phrase in flat:
            exact.append(item)
            continue
        parts = phrase.split()
        if all(any(same_word(p, w) for w in haystack) for p in parts):
            fuzzy.append(item)
            continue
        missing.append(item)
    return exact, fuzzy, missing


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Покрытие фраз кластера в собранной странице услуги.",
        epilog=(
            "Примеры:\n"
            "  python3 tools/geo_match.py --slug seo\n"
            "  python3 tools/geo_match.py --slug seo --title \"...\" --subtitle \"...\""
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--slug", required=True, help="id кластера = slug услуги (seo, ecommerce, …)")
    parser.add_argument("--cluster", help="id кластера, если не совпадает со slug (например marketplace → ecommerce)")
    parser.add_argument("--dist", default=os.path.join(ROOT, "dist"), help="папка сборки")
    parser.add_argument("--semantics", default=os.path.join(ROOT, "docs", "semantics", "semantics.json"))
    parser.add_argument("--top", type=int, default=10, help="сколько фраз показывать в списках")
    parser.add_argument("--title", help="подменить title (проверка варианта)")
    parser.add_argument("--h1", dest="h1", help="подменить H1 (проверка варианта)")
    parser.add_argument("--subtitle", help="подменить первый абзац (проверка варианта)")
    args = parser.parse_args()

    page_path = os.path.join(args.dist, "services", args.slug, "index.html")
    if not os.path.exists(page_path):
        print(f"ОШИБКА: нет сборки {page_path}. Сначала `npm run build`.", file=sys.stderr)
        return 2

    page = PageText()
    with open(page_path, encoding="utf-8") as fh:
        page.feed(fh.read())

    title = args.title if args.title is not None else page.title
    h1 = args.h1 if args.h1 is not None else page.h1
    first_p = args.subtitle if args.subtitle is not None else page.first_p

    # H1 размечен вертикальной чертой «|» как перенос строки — она не часть фразы.
    text = " ".join([title, h1.replace("|", " "), first_p])

    cluster = load_cluster(args.semantics, args.cluster or args.slug)
    commercial = [i for i in (cluster.get("items") or []) if i.get("intent") == "commercial"]

    exact, fuzzy, missing = coverage(text, commercial)
    covered = len(exact) + len(fuzzy)

    # Фразы с данными по спросу — честный знаменатель: остальные могут быть
    # синтетическими комбинациями без единого запроса в месяц.
    with_data = [i for i in commercial if (i.get("vacancies") or 0) > 0]
    exact_d, fuzzy_d, _ = coverage(text, with_data)
    covered_d = len(exact_d) + len(fuzzy_d)

    print(f"Услуга: {args.slug} — {cluster.get('title')}")
    print(f"Страница: {os.path.relpath(page_path, ROOT)}")
    print()
    print(f"TITLE:   {title.strip()}")
    print(f"H1:      {h1.strip()}")
    print(f"АБЗАЦ:   {first_p.strip()}")
    print()
    print(f"Коммерческих фраз в кластере: {len(commercial)}")
    print(f"Покрыто дословно: {len(exact)}")
    print(f"Покрыто по словам: {len(fuzzy)}")
    print(f"Итого покрытие: {covered}  (порог ATP-G1: ≥{THRESHOLD}) — "
          f"{'ВЫПОЛНЕНО' if covered >= THRESHOLD else 'НЕ ВЫПОЛНЕНО'}")
    print(f"Из фраз с данными по спросу: {covered_d} из {len(with_data)}")

    if exact:
        print(f"\nДословно (первые {args.top}):")
        for i in sorted(exact, key=lambda x: -(x.get("vacancies") or 0))[: args.top]:
            print(f"  • {i['query']}  ({i.get('vacancies') or 0})")
    if fuzzy:
        print(f"\nПо словам (первые {args.top}):")
        for i in sorted(fuzzy, key=lambda x: -(x.get("vacancies") or 0))[: args.top]:
            print(f"  • {i['query']}  ({i.get('vacancies') or 0})")
    if missing:
        print(f"\nНе покрыто, самые частые ({args.top}):")
        for i in sorted(missing, key=lambda x: -(x.get("vacancies") or 0))[: args.top]:
            print(f"  • {i['query']}  ({i.get('vacancies') or 0})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

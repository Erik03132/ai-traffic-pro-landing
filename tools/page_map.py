#!/usr/bin/env python3
"""
Карта распределения фраз: какая страница сайта владеет какими корнями.

Зачем: если две страницы целятся в одну формулировку, они отбирают позиции
друг у друга (каннибализация). Рост одной гасит падение другой, а суммарный
результат не меняется. Карта фиксирует владельца до правок, а не после.

Что делает: берёт `docs/semantics/semantics.json`, раскладывает корни фраз
по страницам по явным правилам ниже и проверяет, что ни один корень не
достался двум страницам. Пишет `docs/semantics/page-map.json`.

Правила (менять только здесь, осознанно):
  * базово корень принадлежит странице своего кластера;
  * корни ecommerce с признаками маркетплейса уходят на `marketplace`;
  * пересечения кластеров разрешены вручную в OVERRIDES;
  * информационные темы уходят в блог, а не на страницы услуг.

Примеры:
  python3 tools/page_map.py
  python3 tools/page_map.py --json docs/semantics/page-map.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Страницы, которых уже нет: адрес отдаёт редирект на другую страницу.
# `/services/marketplace/` → `/services/ecommerce/` (слияние 28.10.2026,
# см. astro.config.mjs). Оптимизировать редирект-заглушку бессмысленно:
# она отдаётся с noindex, а вес должна получать целевая страница.
MERGED_INTO = {
    "marketplace": "ecommerce",
}

# Ручное переназначение владельца корня.
# Ключ — точный текст корня, значение — slug страницы-владельца.
#
# Важно: в исходной семантике (проверено 03.11.2026) повторов корней между
# кластерами НЕТ — это не разрешение коллизий, а осознанный перенос по
# интенту. Если появится настоящая коллизия, её поймает проверка ниже.
OVERRIDES = {
    # «автоматизация продаж» лежит в leadgen, но интент — про систему учёта,
    # а не про привлечение клиентов, поэтому владелец — CRM.
    "автоматизация продаж": "crm",
    # Общий термин про управление сделками — ближе к CRM, чем к лидогену.
    "управление продажами": "crm",
    # «Интернет-магазин» как объект продаж — страница ecommerce.
    # Страница landing владеет созданием сайтов, включая «интернет-магазин сайт».
    "интернет-магазин": "ecommerce",
}

# Страница блога забирает информационные темы: у них другой интент,
# оптимизировать их под коммерческие заголовки услуг — ошибка.
BLOG_SLUG = "blog"


def load(semantics_path: str) -> dict:
    with open(semantics_path, encoding="utf-8") as fh:
        return json.load(fh)


def owner_for(cluster_id: str, query: str) -> str:
    owner = OVERRIDES.get(query, cluster_id)
    return MERGED_INTO.get(owner, owner)


def build(semantics: dict) -> dict:
    pages: dict[str, dict] = {}
    seen: dict[str, str] = {}
    collisions: list[dict] = []

    for cluster in semantics.get("clusters", []):
        cluster_id = cluster["id"]
        for root in cluster.get("roots", []):
            query = root["query"]
            owner = owner_for(cluster_id, query)
            if query in seen and seen[query] != owner:
                collisions.append({"query": query, "pages": [seen[query], owner]})
            seen[query] = owner
            page = pages.setdefault(owner, {"roots": [], "contributors": []})
            if cluster_id not in page["contributors"]:
                page["contributors"].append(cluster_id)
            page["roots"].append({
                "query": query,
                "vacancies": root.get("vacancies") or 0,
                "trendsAvg": root.get("trendsAvg"),
                "from_cluster": cluster_id,
            })

    for owner, page in pages.items():
        # Кластер страницы — её собственный, если он есть среди источников
        # корней. Иначе (marketplace) — тот кластер, из которого пришли корни.
        page["cluster"] = owner if owner in page["contributors"] else page["contributors"][0]
        page["roots"].sort(key=lambda r: (-r["vacancies"], -(r["trendsAvg"] or 0)))
        page["total_roots"] = len(page["roots"])

    blog_topics = []
    for cluster in semantics.get("clusters", []):
        for topic in cluster.get("informationalTopics", []):
            blog_topics.append({
                "query": topic["query"],
                "vacancies": topic.get("vacancies") or 0,
                "from_cluster": cluster["id"],
            })
    blog_topics.sort(key=lambda t: -t["vacancies"])

    return {
        "generated_from": "docs/semantics/semantics.json",
        "rules": {
            "merged_into": MERGED_INTO,
            "overrides": OVERRIDES,
        },
        "pages": pages,
        "blog": "информационные темы (blogs)",
        "blog_topics": blog_topics,
        "collisions": collisions,
        "home": {
            "note": "главная не соревнуется за коммерческие корни: только бренд и 2–3 главных услуги",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Карта распределения фраз по страницам сайта.",
        epilog="Примеры:\n  python3 tools/page_map.py\n  python3 tools/page_map.py --json docs/semantics/page-map.json",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--semantics", default=os.path.join(ROOT, "docs", "semantics", "semantics.json"))
    parser.add_argument("--json", help="куда записать карту (по умолчанию только печать)")
    parser.add_argument("--top", type=int, default=5, help="сколько корней показывать на страницу")
    args = parser.parse_args()

    if not os.path.exists(args.semantics):
        print(f"ОШИБКА: нет файла {args.semantics}", file=sys.stderr)
        return 2

    result = build(load(args.semantics))

    for slug, page in sorted(result["pages"].items(), key=lambda kv: -sum(r["vacancies"] for r in kv[1]["roots"])):
        demand = sum(r["vacancies"] for r in page["roots"])
        print(f"\n{slug:<12} кластер {page['cluster']:<11} корней {page['total_roots']:>3}  спрос {demand:>7}")
        for root in page["roots"][: args.top]:
            moved = "" if root["from_cluster"] == page["cluster"] else f"  (из {root['from_cluster']})"
            print(f"   • {root['query']:<40} {root['vacancies']:>7}{moved}")

    print(f"\nБлог: {len(result['blog_topics'])} информационных тем, топ-3:")
    for topic in result["blog_topics"][:3]:
        print(f"   • {topic['query']} ({topic['vacancies']})")

    if result["collisions"]:
        print("\nКОЛЛИЗИИ (один корень у двух страниц):")
        for c in result["collisions"]:
            print(f"   ! {c['query']}: {c['pages']}")
    else:
        print("\nКоллизий нет: каждый корень принадлежит ровно одной странице.")

    if args.json:
        path = args.json if os.path.isabs(args.json) else os.path.join(ROOT, args.json)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"Карта записана: {os.path.relpath(path, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

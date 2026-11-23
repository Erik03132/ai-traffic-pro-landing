#!/usr/bin/env python3
"""Сборка списка фраз для мониторинга позиций (ядро + хвост).

Вход:
  * `docs/semantics/page-map.json`   — маппинг запрос → страница услуги;
  * `docs/semantics/wordstat-moscow-2026-11.json` — реальная частотность
    (Wordstat, Москва, 13.10–11.11.2026). Считается основным источником
    приоритета: оценки по вакансиям hh.ru из page-map местами завышены
    в разы («сео услуги» — 1400 вакансий против 733 запросов в месяц).

Правила:
  * в ядро попадают фразы с частотностью ≥ CORE_MIN_FREQ;
  * гео- и коммерческие варианты добавляются только к базовым фразам,
    которые уже в ядре (иначе получим 200+ бессмысленных длинных хвостов);
  * кластер GEO/AI отделён: там нужен не замер позиции, а замер упоминаний
    в ответах ИИ, поэтому его фразы помечены `engine: ai-assistants`.

Запуск:
    python3 tools/positions/build_keywords.py --dry-run
    python3 tools/positions/build_keywords.py --out data/keywords-monitoring.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGE_MAP = ROOT / "docs/semantics/page-map.json"
WORDSTAT = ROOT / "docs/semantics/wordstat-moscow-2026-11.json"
DEFAULT_OUT = ROOT / "data/keywords-monitoring.json"

PAGE_SLUG = {
    "seo": "seo",
    "geo-ai": "geo",
    "leadgen": "leadgen",
    "advertising": "advertising",
    "smm": "smm",
    "landing": "landing",
    "crm": "crm",
    "ecommerce": "ecommerce",
}

# Порог входа в ядро (запросов в месяц по Москве).
CORE_MIN_FREQ = 200

# Гео: 213 = Москва. Варианты берём только там, где Wordstat подтвердил спрос.
GEO = [
    {"suffix": "москва", "lr": 213, "region": "Москва"},
    {"suffix": "московская область", "lr": 213, "region": "Московская область"},
]

# Коммерческие модификаторы: ближе к покупке, чем «услуга».
COMMERCIAL = ["цена", "стоимость", "заказать"]

# Кластер GEO/AI: отдельный замер (упоминания в ответах нейросетей).
AI_CLUSTER_ID = "geo-ai"
AI_PAGE = "/services/geo/"


def die(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path) -> dict:
    if not path.exists():
        die(f"Файл не найден: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        die(f"Невалидный JSON в {path}: {exc}")


def build() -> dict:
    page_map = load_json(PAGE_MAP)
    ws = load_json(WORDSTAT)
    freq: dict[str, int | None] = {}
    for cluster in ws.get("base", {}).values():
        freq.update(cluster)
    freq.update(ws.get("geo_moscow", {}))
    freq.update(ws.get("commercial", {}))

    phrases: list[dict] = []
    seen: set[str] = set()

    def add(phrase: str, **fields) -> None:
        key = phrase.strip().lower()
        if not key or key in seen:
            return
        seen.add(key)
        phrases.append({"phrase": phrase, **fields})

    for cluster_id, page in page_map.get("pages", {}).items():
        slug = PAGE_SLUG.get(cluster_id, cluster_id)
        landing = f"/services/{slug}/"
        candidates = sorted(
            page.get("roots", []),
            key=lambda r: freq.get(r["query"]) or 0,
            reverse=True,
        )
        for root in candidates:
            query = root["query"]
            value = freq.get(query)
            if value is None:
                continue
            if value < CORE_MIN_FREQ:
                continue
            base = {
                "cluster": cluster_id,
                "page": landing,
                "engines": ["yandex", "google", "ai-assistants"]
                if cluster_id == AI_CLUSTER_ID
                else ["yandex", "google"],
                "freq_msk": value,
                "variant": "base",
                "lr": None,
            }
            if cluster_id == AI_CLUSTER_ID:
                base["note"] = (
                    "Позиция в классической выдаче не показатель — нужен замер "
                    "упоминаний в ИИ."
                )
            add(query, **base)
            for geo in GEO:
                geo_phrase = f"{query} {geo['suffix']}"
                geo_value = freq.get(geo_phrase)
                if geo_value is None or geo_value < CORE_MIN_FREQ:
                    continue
                add(
                    geo_phrase,
                    **{
                        **base,
                        "variant": f"geo:{geo['suffix']}",
                        "lr": geo["lr"],
                        "region": geo["region"],
                        "freq_msk": geo_value,
                    },
                )
            for mod in COMMERCIAL:
                mod_phrase = f"{query} {mod}"
                mod_value = freq.get(mod_phrase)
                if mod_value is None or mod_value < CORE_MIN_FREQ:
                    continue
                add(
                    mod_phrase,
                    **{
                        **base,
                        "variant": f"commercial:{mod}",
                        "freq_msk": mod_value,
                    },
                )

    # Кластер GEO/AI — всегда целиком, с отдельным движком замера.
    # Фразы с нулевой частотой в классической выдаче помечаем `watch`:
    # их нельзя отслеживать позицией, они идут в отдельный замер ИИ.
    for query, value in sorted(
        ws.get("base", {}).get(AI_CLUSTER_ID, {}).items(),
        key=lambda kv: kv[1] or 0,
        reverse=True,
    ):
        add(
            query,
            cluster=AI_CLUSTER_ID,
            page=AI_PAGE,
            engines=["yandex", "google", "ai-assistants"],
            freq_msk=value,
            variant="base",
            lr=None,
            note="Позиция в классической выдаче не показатель — нужен замер упоминаний в ИИ.",
            watch_only=value is None,
        )

    for idx, phrase in enumerate(phrases):
        phrase["priority"] = idx + 1

    return {
        "generated_at": "2026-11-23",
        "sources": {
            "semantics": "docs/semantics/page-map.json",
            "frequency": "docs/semantics/wordstat-moscow-2026-11.json",
        },
        "regions": {"yandex_lr": 213, "gsc_country": "rus"},
        "core_min_freq": CORE_MIN_FREQ,
        "clusters": sorted({p["cluster"] for p in phrases}),
        "phrases": phrases,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Собрать список фраз для мониторинга позиций.",
        epilog='Пример: python3 tools/positions/build_keywords.py --out data/keywords-monitoring.json',
    )
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Путь к JSON со списком фраз")
    parser.add_argument("--min-freq", type=int, default=CORE_MIN_FREQ, help="Порог запросов в месяц для ядра")
    parser.add_argument("--dry-run", action="store_true", help="Показать сводку, файл не писать")
    args = parser.parse_args()

    payload = build()
    if args.min_freq != CORE_MIN_FREQ:
        payload["core_min_freq"] = args.min_freq
        payload["phrases"] = [
            p for p in payload["phrases"] if (p.get("freq_msk") or 0) >= args.min_freq
        ]
        for idx, phrase in enumerate(payload["phrases"]):
            phrase["priority"] = idx + 1

    phrases = payload["phrases"]
    by_cluster: dict[str, int] = {}
    for p in phrases:
        by_cluster[p["cluster"]] = by_cluster.get(p["cluster"], 0) + 1

    if args.dry_run:
        print(f"Всего фраз: {len(phrases)}")
        for cluster, count in sorted(by_cluster.items()):
            print(f"  {cluster:12} {count}")
        print("Топ-20 по частоте:")
        for p in sorted(phrases, key=lambda x: x.get("freq_msk") or 0, reverse=True)[:20]:
            print(f"  {p.get('freq_msk') or 0:>9}  {p['phrase']}")
        return 0

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Записано {len(phrases)} фраз → {out}")
    for cluster, count in sorted(by_cluster.items()):
        print(f"  {cluster:12} {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

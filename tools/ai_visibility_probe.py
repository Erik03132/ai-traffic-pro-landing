#!/usr/bin/env python3
"""
Замер видимости бренда в ответах нейросетей (GEO-аудит, шаг «замер»).

Зачем: методика на `/geo-audit/methodology/` обещает Citation Rate, Share of
Voice и Brand Mention Rate с формулами и сырыми ответами. Этот скрипт —
исполнение обещания, а не отдельная утилита: он же будет считать отчёты клиентам.

Как работает: POST `/v1/responses` с инструментом `web_search` (серверный поиск
OpenAI через ProxyAPI). Считаем по тексту ответа и по аннотациям-источникам:
  Citation Rate    = прогоны, где процитирован наш домен ÷ все прогоны
  Brand Mention    = прогоны, где назван бренд (со ссылкой или без) ÷ все прогоны
  Share of Voice   = наши упоминания ÷ упоминания всех компаний из списка

Почему через API, а не в браузере: в аккаунте владельца ChatGPT знает проект и
подстраивает ответ — замер получается про себя, а не про рынок. У API нет памяти
и пользовательских инструкций, ответ чистый. Ограничение метода (персонализация,
регион, дата) записано в `docs/seo/ai-visibility-*.md` и на странице методики.

Примеры:
  python3 tools/ai_visibility_probe.py --dry-run
  python3 tools/ai_visibility_probe.py --runs 3 --out docs/seo/raw/2026-11-24
  python3 tools/ai_visibility_probe.py --query "кто делает GEO" --runs 1 --dry-run

Ключ: `PROXYAPI_API_KEY` в `.env` проекта (или переменная окружения).
Коды выхода: 0 — замер сделан, 1 — часть прогонов упала, 2 — нет ключа, 4 — аргументы.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://api.proxyapi.ru/openai/v1"

BRAND = "AI-TRAFFIC-PRO"
DOMAIN = "ai-traffic-pro.ru"
BRAND_PATTERNS = [
    r"ai[\s-]*traffic[\s-]*pro",
    r"ай[\s-]*трафик[\s-]*про",
]

# Кого считаем в Share of Voice: реальные GEO-конкуренты из разведки 24.11.2026
# (docs/seo/competitor-cards-2026-11-24.md). Список правится здесь, а не в отчёте.
COMPETITORS = [
    ("vverh.digital", r"vverh[.\s-]?digital|вверх[.\s-]?digital"),
    ("nevsky.agency", r"nevsky[.\s-]?agency|невский[.\s-]?agency"),
    ("vzlet.agency", r"vzlet[.\s-]?agency|взлёт[.\s-]?agency|взлет[.\s-]?agency"),
    ("tapbox.ru", r"tapbox"),
    ("trafficpro.agency", r"trafficpro"),
]

# Фиксированный набор: меняется только осознанно, иначе динамика несравнима.
DEFAULT_QUERIES = [
    "AI-TRAFFIC-PRO маркетинговое агентство",
    "как попасть в ответы нейросетей GEO продвижение",
    "как посчитать окупаемость рекламы ROMI",
    "маркетинговое агентство полного цикла Россия",
    "llms.txt зачем нужен сайту",
]


def load_key() -> str:
    key = os.environ.get("PROXYAPI_API_KEY", "").strip()
    if key:
        return key
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("PROXYAPI_API_KEY="):
                return line.split("=", 1)[1].strip()
    return ""


def api_model(name: str) -> str:
    """Имя модели для `/v1/responses` — без префикса вендора.

    Ловушка ProxyAPI (проверено 24.11.2026): документация показывает
    `openai/gpt-5-mini`, но `/v1/responses` на префикс отвечает
    `400 Model not supported`. Короткое имя работает, а в `/v1/models`
    модель числится с префиксом. Поэтому префикс снимаем здесь, а не в
    вызывающем коде: иначе замер молча падает на всех прогонах.
    """
    return name.split("/")[-1] if "/" in name else name


def ask(key: str, model: str, query: str, timeout: int) -> dict:
    """Один прогон. Возвращает {'text', 'citations', 'error'} — без исключений наружу."""
    payload = {
        "model": api_model(model),
        "input": query,
        "tools": [{"type": "web_search"}],
        # Просим опираться на поиск: модель вправе ответить по памяти, и тогда
        # это уже не «что показывает ChatGPT», а «что модель помнит».
        "instructions": (
            "Найди актуальные источники в интернете и ответь, опираясь на них. "
            "Назови компании и сайты, которые нашёл, со ссылками."
        ),
    }
    req = urllib.request.Request(
        f"{BASE_URL}/responses",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return {"text": "", "citations": [], "error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:  # noqa: BLE001 — сеть/таймаут: пишем причину, не падаем
        return {"text": "", "citations": [], "error": f"{type(e).__name__}: {e}"}

    text, citations = [], []
    for item in data.get("output", []) or []:
        for c in item.get("content", []) or []:
            if c.get("text"):
                text.append(c["text"])
            for a in c.get("annotations", []) or []:
                if a.get("url"):
                    citations.append(a["url"])
    return {"text": "\n".join(text), "citations": citations, "error": None}


def host(url: str) -> str:
    return urlparse(url).netloc.lower().replace("www.", "")


def analyse(res: dict) -> dict:
    text = res["text"]
    low = text.lower()
    our_cites = [u for u in res["citations"] if host(u).endswith(DOMAIN)]
    brand = any(re.search(p, low) for p in BRAND_PATTERNS)
    comps = []
    for name, pattern in COMPETITORS:
        if re.search(pattern, low) or any(host(u) == name for u in res["citations"]):
            comps.append(name)
    return {"brand": brand, "our_cites": our_cites, "competitors": comps}


def pct(part: int, total: int) -> str:
    return f"{round(100 * part / total)}%" if total else "—"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Замер видимости бренда в ответах модели через /v1/responses + web_search.",
        epilog="пример: python3 tools/ai_visibility_probe.py --runs 3 --out docs/seo/raw/2026-11-24",
    )
    ap.add_argument("--query", action="append", default=[], help="запрос (можно несколько)")
    ap.add_argument("--runs", type=int, default=3, help="прогонов на запрос (по умолчанию 3)")
    ap.add_argument("--model", default="gpt-5-mini", help="идентификатор модели (префикс вендора снимается)")
    ap.add_argument("--out", default="", help="каталог для сырых ответов (JSON)")
    ap.add_argument("--timeout", type=int, default=180, help="таймаут одного прогона, с")
    ap.add_argument("--dry-run", action="store_true", help="показать план, не тратить деньги")
    args = ap.parse_args(argv)

    queries = args.query or DEFAULT_QUERIES
    if args.runs < 1:
        print("--runs должен быть ≥ 1", file=sys.stderr)
        return 4

    if args.dry_run:
        print(f"модель: {api_model(args.model)} · поиск: web_search · прогонов: {len(queries)}×{args.runs}")
        for q in queries:
            print(f"  · {q}")
        print("стоимость: 1 ₽ за поисковый запрос + токены; dry-run денег не тратит")
        return 0

    key = load_key()
    if not key:
        print("нет PROXYAPI_API_KEY (env или .env) — ключ: https://console.proxyapi.ru/keys", file=sys.stderr)
        return 2

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M")
    out_dir = Path(args.out) if args.out else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    rows, failures = [], 0
    for q in queries:
        runs = []
        for i in range(1, args.runs + 1):
            res = ask(key, args.model, q, args.timeout)
            if res["error"]:
                failures += 1
                print(f"[FAIL] {q} · прогон {i}: {res['error']}", file=sys.stderr)
            a = analyse(res)
            runs.append({**a, "error": res["error"], "citations": res["citations"], "text": res["text"]})
            if out_dir:
                name = re.sub(r"[^a-z0-9]+", "-", q.lower())[:50]
                (out_dir / f"{stamp}_{name}_{i}.json").write_text(
                    json.dumps(
                        {"query": q, "run": i, "model": args.model, "at": stamp, **res},
                        ensure_ascii=False,
                        indent=2,
                    ),
                    encoding="utf-8",
                )
            time.sleep(1)  # не бьём лимиты: прогоны идут подряд
        ok = [r for r in runs if not r["error"]]
        rows.append(
            {
                "query": q,
                "runs": len(runs),
                "ok": len(ok),
                "cite": sum(1 for r in ok if r["our_cites"]),
                "mention": sum(1 for r in ok if r["brand"]),
                "competitors": sorted({c for r in ok for c in r["competitors"]}),
            }
        )

    total_ok = sum(r["ok"] for r in rows)
    print(f"\n### Замер: {api_model(args.model)} · {stamp} · прогонов ок {total_ok}/{sum(r['runs'] for r in rows)}\n")
    print("| № | Запрос | Citation Rate | Brand Mention | Кто в ответе |")
    print("|---|---|---|---|---|")
    for i, r in enumerate(rows, 1):
        who = ", ".join(r["competitors"]) if r["competitors"] else "—"
        print(f"| {i} | {r['query']} | {pct(r['cite'], r['ok'])} | {pct(r['mention'], r['ok'])} | {who} |")

    mentions = sum(r["mention"] for r in rows)
    comp_hits = sum(len(r["competitors"]) for r in rows)
    print(
        f"\nИтого: Citation Rate {pct(sum(r['cite'] for r in rows), total_ok)} · "
        f"Brand Mention {pct(mentions, total_ok)} · "
        f"Share of Voice {pct(mentions, mentions + comp_hits)} (наши упоминания ÷ все компании из списка)"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

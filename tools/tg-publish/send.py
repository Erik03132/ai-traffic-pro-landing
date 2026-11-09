#!/usr/bin/env python3
"""Отправка черновика поста в Telegram с кнопкой «Опубликовать в канал».

Черновик уходит владельцу канала в личный чат с ботом. Публикация — только
по нажатию кнопки под сообщением: бот не постит сам.

Ссылка в тексте пишется как `[фраза]({{link}})`: слаг, UTM-метки и кнопку
«Читать статью» подставит Worker — в тексте их держать не нужно.

Примеры:
  python3 tools/tg-publish/send.py --slug voronka-prodazh-kak-postroit
  python3 tools/tg-publish/send.py --slug crm-i-erp-raznica \\
      --text-file docs/distribution/posts/crm-i-erp-raznica.post-2.md --content post-2
  python3 tools/tg-publish/send.py --slug test --text "Проверка [ссылки]({{link}})." --dry-run

Если `--text-file` и `--text` не заданы, берётся `docs/distribution/posts/<slug>.md`.
Токен — переменная `TG_PUBLISH_TOKEN` или строка в `.env` в корне проекта.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE = "https://ai-traffic-pro-api.erik03132.workers.dev"
USER_AGENT = "ai-traffic-pro-publish/1.0 (+https://ai-traffic-pro.ru)"
POSTS_DIR = ROOT / "docs" / "distribution" / "posts"


def read_token() -> str:
    """Токен из окружения или из `.env` в корне проекта."""
    token = os.environ.get("TG_PUBLISH_TOKEN", "").strip()
    if token:
        return token

    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.startswith("TG_PUBLISH_TOKEN="):
                return line.split("=", 1)[1].strip()

    raise SystemExit(
        "нет токена: задайте TG_PUBLISH_TOKEN в окружении или в .env (см. README)"
    )


def resolve_text(args: argparse.Namespace) -> str:
    """Текст поста: аргумент, файл или `docs/distribution/posts/<slug>.md`."""
    if args.text:
        return args.text

    path = Path(args.text_file) if args.text_file else POSTS_DIR / f"{args.slug}.md"
    if not path.exists():
        raise SystemExit(f"нет файла с текстом: {path}")
    return path.read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Отправить черновик поста в Telegram на подтверждение.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Примеры:\n"
            "  send.py --slug voronka-prodazh-kak-postroit\n"
            "  send.py --slug crm-i-erp-raznica --text-file post.md --content post-2\n"
            "  send.py --slug test --text 'Проверка [ссылки]({{link}}).' --dry-run"
        ),
    )
    parser.add_argument("--slug", required=True, help="слаг статьи: /blog/<slug>/")
    parser.add_argument("--text", help="текст поста строкой (не с файлом)")
    parser.add_argument("--text-file", help="файл с текстом поста")
    parser.add_argument("--content", help="utm_content: номер поста, например post-2")
    parser.add_argument("--base-url", default=DEFAULT_BASE, help=f"адрес Worker (по умолчанию {DEFAULT_BASE})")
    parser.add_argument("--dry-run", action="store_true", help="показать, что будет отправлено, и выйти")
    args = parser.parse_args()

    text = resolve_text(args).strip()
    if not text:
        raise SystemExit("пустой текст поста")

    payload = {"slug": args.slug, "text": text}
    if args.content:
        payload["content"] = args.content

    if args.dry_run:
        print(f"POST {args.base_url}/api/tg/preview")
        print(f"slug: {args.slug}  content: {args.content or '—'}")
        print(f"символов в тексте: {len(text)}")
        print("---")
        print(text)
        return 0

    token = read_token()
    request = urllib.request.Request(
        f"{args.base_url.rstrip('/')}/api/tg/preview",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            # Cloudflare (правило 1010) режет запросы с User-Agent вида
            # `Python-urllib/3.x`, поэтому представляемся явно.
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        print(f"ошибка {error.code}: {detail}", file=sys.stderr)
        return 1
    except urllib.error.URLError as error:
        print(f"сеть недоступна: {error.reason}", file=sys.stderr)
        return 1

    data = json.loads(body)
    if not data.get("ok"):
        print(f"не отправлено: {data}", file=sys.stderr)
        return 1

    print(f"черновик отправлен: {data.get('slug')} → {data.get('link')}")
    print("откройте Telegram и нажмите «Опубликовать в канал»")
    return 0


if __name__ == "__main__":
    sys.exit(main())

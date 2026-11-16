"""Тесты реестра дистрибуции и рендера постов.

Запуск: `python3 -m unittest discover -s tools/publish -p 'test_*.py'`
(в `npm test` подключено).
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest

import registry
import render

POST_BODY = "Первый абзац про канал.\n\nЧитать разбор → [разбор]({{link}})"


def make_root(tmp: str, *, posts: dict[str, str] | None = None, blog: list[str] | None = None) -> str:
    """Создаёт минимальное дерево проекта во временной папке."""
    for slug in blog or ["test-slug"]:
        path = os.path.join(tmp, "src", "data", "blog", f"{slug}.ts")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("export const article = {};\n")

    posts_dir = os.path.join(tmp, "docs", "distribution", "posts")
    os.makedirs(posts_dir, exist_ok=True)
    for name, body in (posts or {}).items():
        with open(os.path.join(posts_dir, name), "w", encoding="utf-8") as handle:
            handle.write(body)
    return tmp


def entry(**patch) -> dict:
    base = {
        "id": "test-slug:post-1:telegram",
        "slug": "test-slug",
        "post": "post-1",
        "channel": "telegram",
        "status": "queued",
        "plannedAt": None,
        "messageId": None,
        "url": None,
        "error": None,
    }
    base.update(patch)
    return base


class LinkTest(unittest.TestCase):
    def test_build_link_repeats_worker_format(self):
        self.assertEqual(
            render.build_link("kak-vybrat-kanal-prodvizheniya", "post-1", "telegram"),
            "https://ai-traffic-pro.ru/blog/kak-vybrat-kanal-prodvizheniya/"
            "?utm_source=telegram&utm_medium=social"
            "&utm_campaign=kak-vybrat-kanal-prodvizheniya&utm_content=post-1",
        )

    def test_build_link_marks_channel(self):
        self.assertIn("utm_source=vk", render.build_link("a", "post-2", "vk"))

    def test_render_substitutes_placeholder(self):
        self.assertEqual(render.render("x {{link}} y", "https://e.x"), "x https://e.x y")


class PostTextTest(unittest.TestCase):
    def test_header_is_stripped(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": "# Заголовок\nСтатья: /blog/x/\n\n---\n\n" + POST_BODY})
            self.assertEqual(registry.post_text("test-slug", "post-1", tmp), POST_BODY)

    def test_missing_file_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp)
            self.assertIsNone(registry.post_text("test-slug", "post-1", tmp))

    def test_file_without_header_keeps_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            self.assertEqual(registry.post_text("test-slug", "post-1", tmp), POST_BODY)


class CheckTextTest(unittest.TestCase):
    def test_short_text_passes_caption_limit(self):
        report = render.check_text("короткий пост", "telegram")
        self.assertTrue(report["ok"])
        self.assertEqual(report["limit"], 1024)
        self.assertEqual(report["errors"], [])

    def test_long_text_fails_with_numbers(self):
        report = render.check_text("я" * 1100, "telegram")
        self.assertFalse(report["ok"])
        self.assertIn("1100", report["errors"][0])
        self.assertIn("1024", report["errors"][0])

    def test_no_photo_uses_message_limit(self):
        report = render.check_text("я" * 1100, "telegram", has_photo=False)
        self.assertTrue(report["ok"])
        self.assertEqual(report["limit"], 4096)

    def test_empty_text_fails(self):
        self.assertFalse(render.check_text("   ", "telegram")["ok"])

    def test_placeholder_checked_on_template_not_on_result(self):
        template = POST_BODY
        body = render.render(template, "https://ai-traffic-pro.ru/blog/test-slug/")
        report = render.check_text(body, "telegram", template=template)
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["chars"], len(body))

    def test_two_placeholders_are_an_error(self):
        report = render.check_text("{{link}} и {{link}}", "telegram")
        self.assertFalse(report["ok"])
        self.assertTrue(any("2 раза" in error for error in report["errors"]))

    def test_formatting_warnings(self):
        report = render.check_text("# заголовок\n**жирный**\n\n\nтаб\tтут", "telegram")
        joined = " ".join(report["warnings"])
        self.assertIn("решётку", joined)
        self.assertIn("markdown", joined)
        self.assertIn("табуляция", joined)
        self.assertIn("пустой строки", joined)

    def test_unknown_channel_has_no_limit(self):
        report = render.check_text("я" * 20000, "dzen")
        self.assertTrue(report["ok"])
        self.assertIsNone(report["limit"])


class StatusTest(unittest.TestCase):
    def test_forward_transitions(self):
        self.assertTrue(registry.can_transition("draft", "queued"))
        self.assertTrue(registry.can_transition("queued", "approved"))
        self.assertTrue(registry.can_transition("approved", "posted"))
        self.assertTrue(registry.can_transition("failed", "queued"))

    def test_posted_is_final(self):
        self.assertFalse(registry.can_transition("posted", "queued"))

    def test_no_jump_over_approval(self):
        self.assertFalse(registry.can_transition("queued", "posted"))

    def test_mark_posted_records_message(self):
        data = {"publications": [entry(status="approved")]}
        updated = registry.set_status(data, "test-slug:post-1:telegram", "posted", message_id=7, url="https://t.me/x/7")
        self.assertEqual(updated["status"], "posted")
        self.assertEqual(updated["messageId"], 7)
        self.assertEqual(updated["url"], "https://t.me/x/7")

    def test_failed_requires_reason(self):
        data = {"publications": [entry(status="queued")]}
        with self.assertRaises(ValueError):
            registry.set_status(data, "test-slug:post-1:telegram", "failed")

    def test_backward_transition_raises(self):
        data = {"publications": [entry(status="posted", messageId=1)]}
        with self.assertRaises(ValueError):
            registry.set_status(data, "test-slug:post-1:telegram", "queued")

    def test_unknown_id_raises(self):
        with self.assertRaises(KeyError):
            registry.set_status({"publications": []}, "nope:post-1:telegram", "queued")


class ValidateTest(unittest.TestCase):
    def test_clean_registry_passes(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            self.assertEqual(registry.validate({"publications": [entry()]}, tmp), [])

    def test_duplicate_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            errors = registry.validate({"publications": [entry(), entry()]}, tmp)
            self.assertTrue(any("повторяется" in error for error in errors))

    def test_unknown_channel_and_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            errors = registry.validate(
                {"publications": [entry(channel="instagram", status="wanted")]}, tmp
            )
            joined = " ".join(errors)
            self.assertIn("неизвестный канал", joined)
            self.assertIn("неизвестный статус", joined)

    def test_slug_must_exist_in_blog(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            errors = registry.validate({"publications": [entry(slug="ghost-slug")]}, tmp)
            self.assertTrue(any("нет в src/data/blog" in error for error in errors))

    def test_queued_without_text_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp)
            errors = registry.validate({"publications": [entry()]}, tmp)
            self.assertTrue(any("нет файла текста" in error for error in errors))

    def test_draft_without_text_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp)
            self.assertEqual(registry.validate({"publications": [entry(status="draft")]}, tmp), [])

    def test_posted_without_trace_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            errors = registry.validate(
                {"publications": [entry(status="posted", messageId=None, url=None)]}, tmp
            )
            self.assertTrue(any("без messageId" in error for error in errors))

    def test_bad_planned_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            errors = registry.validate({"publications": [entry(plannedAt="19.11.2026")]}, tmp)
            self.assertTrue(any("plannedAt" in error for error in errors))

    def test_bad_id_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            make_root(tmp, posts={"test-slug.post-1.md": POST_BODY})
            errors = registry.validate({"publications": [entry(id="test-slug-post-1")]}, tmp)
            self.assertTrue(any("id должен быть" in error for error in errors))


class SaveLoadTest(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "registry.json")
            data = {"publications": [entry()]}
            registry.save(data, path)
            self.assertEqual(registry.load(path), data)
            with open(path, encoding="utf-8") as handle:
                self.assertIn("test-slug:post-1:telegram", handle.read())

    def test_broken_file_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "registry.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"items": []}, handle)
            with self.assertRaises(ValueError):
                registry.load(path)


class ProjectRegistryTest(unittest.TestCase):
    """Реальный реестр проекта: проверка того, что лежит в git."""

    def test_project_registry_is_valid(self):
        data = registry.load()
        self.assertEqual(registry.validate(data), [])

    def test_every_post_fits_its_channel(self):
        data = registry.load()
        for item in data["publications"]:
            if item["status"] == "draft":
                continue
            report = render.prepare(item)
            with self.subTest(item=item["id"]):
                self.assertTrue(report["ok"], report["errors"])


if __name__ == "__main__":
    unittest.main()

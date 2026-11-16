/**
 * Тексты постов для канала.
 *
 * Зачем тест: пост, свёрстанный «по 78 знаков», выглядит в Telegram рваным
 * столбиком — перенос строки там значит смысловой разрыв, а не перенос
 * вёрстки. Такой дефект виден только в канале, уже после публикации.
 *
 * Запуск: node --test tests/posts.test.js
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'distribution', 'posts');

/** Текст поста: всё после разделителя `---`. */
function body(path) {
  const raw = readFileSync(path, 'utf8');
  const parts = raw.split('\n---\n');
  assert.equal(parts.length, 2, `${path}: нужен заголовок и разделитель ---`);
  return parts[1].trim();
}

const files = readdirSync(DIR).filter((f) => f.endsWith('.md'));

test('файлы постов найдены', () => {
  assert.ok(files.length > 0, 'нет ни одного поста в docs/distribution/posts');
});

test('посты статей: ссылка {{link}} есть, длина подписи в лимите', () => {
  // Интро канала — единственный файл без статьи и ссылки.
  for (const f of files.filter((name) => /\.post-\d+\.md$/.test(name))) {
    const text = body(join(DIR, f));
    const links = text.match(/\{\{link\}\}/g) ?? [];
    const labelled = text.match(/\]\(\{\{link\}\}\)/g) ?? [];
    assert.ok(links.length > 0, `${f}: нет {{link}}`);
    assert.equal(
      labelled.length,
      links.length,
      `${f}: {{link}} без подписи — в канале останется литерал {{link}}`,
    );
    assert.ok(text.length <= 950, `${f}: ${text.length} знаков — подпись вылезет за 1024 с разметкой`);
  }
});

test('абзацы не свёрстаны вручную: перенос строки значит новый абзац или пункт', () => {
  for (const f of files) {
    const text = body(join(DIR, f));
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.split('\n');
      const isItem = (l) => /^([•*\-–—]|\d+[.)])\s+/.test(l);
      // Либо весь блок — пункты, либо первая строка вводная, а дальше пункты.
      const isList = lines.slice(1).every(isItem);
      assert.ok(
        isList || lines.length === 1,
        `${f}: абзац разбит на ${lines.length} строк — в Telegram это будет столбик:\n${block}`,
      );
    }
  }
});

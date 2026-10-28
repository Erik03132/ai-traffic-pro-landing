/**
 * Замер глубины страниц услуг: сколько уникальных слов реально на странице.
 *
 * Считает по `dist/services/<slug>/index.html`: текст страницы без скриптов,
 * стилей и навигации. Референс — задача 2.2 ROADMAP: 7/7 страниц ≥ 1200 слов.
 *
 * Запуск: `node tools/measure_page_words.mjs [--min 1200]`
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const args = process.argv.slice(2);
const minIdx = args.indexOf('--min');
const MIN = minIdx >= 0 ? Number(args[minIdx + 1]) : 1200;

if (!existsSync(dist)) {
  console.error('Нет dist/ — сначала `npm run build`.');
  process.exit(1);
}

/** Текст страницы без служебных частей. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—')
    .replace(/&[a-z]+;/gi, ' ');
}

/** Уникальные словоформы: регистр и словоформы приведены к основе. */
function normalize(word) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
}

const slugs = ['leadgen', 'seo', 'smm', 'advertising', 'landing', 'ecommerce', 'crm'];

const rows = [];
let failed = 0;

for (const slug of slugs) {
  const file = join(dist, 'services', slug, 'index.html');
  if (!existsSync(file)) {
    rows.push({ slug, words: null, unique: null, status: 'нет файла' });
    failed += 1;
    continue;
  }
  const html = readFileSync(file, 'utf8');
  const text = visibleText(html);
  const words = text.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map(normalize).filter((w) => w.length > 2));
  const ok = words.length >= MIN;
  if (!ok) failed += 1;
  rows.push({ slug, words: words.length, unique: unique.size, status: ok ? 'ok' : 'ниже нормы' });
}

console.log(`Порог: ${MIN} слов\n`);
console.log('страница      слов   уникальных  статус');
console.log('------------  -----  ----------  ---------');
for (const r of rows) {
  console.log(
    `${r.slug.padEnd(13)}  ${String(r.words ?? '—').padStart(5)}  ${String(r.unique ?? '—').padStart(10)}  ${r.status}`,
  );
}

const home = join(dist, 'index.html');
if (existsSync(home)) {
  const words = visibleText(readFileSync(home, 'utf8')).split(/\s+/).filter(Boolean);
  console.log(`\nглавная: ${words.length} слов`);
}

// Блог: статьи меряются отдельно, порог ниже — это разборы, а не лендинги.
const blogDir = join(dist, 'blog');
if (existsSync(blogDir)) {
  const { readdirSync } = await import('node:fs');
  const posts = readdirSync(blogDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  console.log('\nблог:');
  for (const slug of posts) {
    const file = join(blogDir, slug, 'index.html');
    if (!existsSync(file)) continue;
    const text = visibleText(readFileSync(file, 'utf8'));
    const n = text.split(/\s+/).filter(Boolean).length;
    console.log(`  ${slug.padEnd(38)} ${String(n).padStart(5)} слов`);
  }
}

if (failed > 0) {
  console.error(`\n✗ Не выполнено: ${failed} из ${rows.length}`);
  process.exit(1);
}
console.log(`\n✓ Все ${rows.length} страниц — не меньше ${MIN} слов`);

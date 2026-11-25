/**
 * NAP-консистентность (3.2 ROADMAP, 25.11.2026).
 *
 * Имя, сайт, телефон и email — один канон в `site.ts`. Тест ловит две
 * типичные поломки: вторую копию контакта в разметке и личную почту в
 * публичном блоке. Внешние карточки (VK, TG, Дзен, Яндекс) правит владелец
 * вручную — здесь проверяется только то, что отдаём мы сами.
 *
 * Запуск: node --test tests/nap.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const site = read('../src/data/site.ts');
const llms = read('../public/llms.txt');
const footer = read('../src/components/Footer.astro');
const requisites = read('../src/pages/requisites.astro');

test('site.ts держит один канон NAP', () => {
  assert.match(site, /name: 'AI-TRAFFIC-PRO'/, 'имя бренда разошлось с каноном');
  assert.match(site, /SITE_URL = 'https:\/\/ai-traffic-pro\.ru'/, 'домен разошёлся с каноном');
  assert.match(site, /phone: '\+7 \(495\) 923-46-44'/, 'телефон разошёлся с каноном');
  assert.match(site, /email: 'info@ai-traffic-pro\.ru'/, 'email разошёлся с каноном');
  assert.match(site, /entity: 'ИП Марченко Дмитрий Николаевич'/, 'исполнитель разошёлся с каноном');
});

test('публичные файлы не содержат второй копии контактов', () => {
  assert.ok(llms.includes('+7 (495) 923-46-44'), 'llms.txt: нет канонического телефона');
  assert.ok(llms.includes('info@ai-traffic-pro.ru'), 'llms.txt: нет канонической почты');
  assert.ok(llms.includes('AI-TRAFFIC-PRO'), 'llms.txt: нет канонического имени');
  assert.ok(footer.includes('SITE.legal.email'), 'футер: почта не из канона');
  assert.ok(footer.includes('SITE.legal.phone'), 'футер: телефон не из канона');
  assert.ok(footer.includes('{SITE.name}'), 'футер: копирайт не из канона');
  assert.ok(requisites.includes('SITE.legal'), 'реквизиты: данные не из канона');
});

test('личная почта не попадает в публичные контакты', () => {
  for (const [label, text] of [
    ['llms.txt', llms],
    ['Footer.astro', footer],
    ['requisites.astro', requisites],
  ]) {
    assert.ok(!text.includes('erik03132@gmail.com'), `${label}: личная почта в публичном контакте`);
  }
});

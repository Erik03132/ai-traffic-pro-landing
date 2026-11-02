/**
 * Конфигурация счётчика Метрики.
 *
 * История (02.11.2026): счётчик был на проде, CSP разрешал загрузку, tag.js
 * отдавался с кодом 200 — а визитов не было. Причина: `ssr: true` в `init`.
 * Опция для SPA/SSR; на статике она молча обрывает инициализацию: ни хита,
 * ни ошибки в консоли. Диагностируется только в браузере (`window.Ya._metrika.counters`).
 *
 * Тест дешёвый, но ловит самую дорогую ошибку — «счётчик стоит, а данных нет».
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS = readFileSync(resolve(ROOT, 'src/components/Analytics.astro'), 'utf8');
const SITE = readFileSync(resolve(ROOT, 'src/data/site.ts'), 'utf8');

test('init не включает ssr — на статике он обрывает инициализацию счётчика', () => {
  assert.doesNotMatch(ANALYTICS, /^\s*ssr:\s*true/m, 'ssr: true снова в init — счётчик не будет слать хиты');
});

test('счётчик инициализируется с trackLinks и clickmap', () => {
  assert.match(ANALYTICS, /trackLinks:\s*true/);
  assert.match(ANALYTICS, /clickmap:\s*true/);
});

test('Webvisor выключен (152-ФЗ: формы собирают телефоны и имена)', () => {
  assert.match(ANALYTICS, /webvisor:\s*false/);
});

test('номер счётчика берётся из окружения сборки, а не из кода', () => {
  assert.match(SITE, /PUBLIC_YM_COUNTER_ID/);
  assert.doesNotMatch(ANALYTICS, /\bym\(1\d{7,}\b/, 'номер счётчика захардкожен в компоненте');
});

test('цели отправляются через единую точку reachGoal', () => {
  assert.match(ANALYTICS, /from '\.\.\/lib\/analytics'/);
});

/**
 * CSP и аналитика.
 *
 * История: 02.11.2026 счётчик Метрики уже стоял на проде, но не загружался —
 * `Content-Security-Policy` из `public/_headers` разрешал только `'self'`.
 * Браузер молча блокировал `tag.js`, визитов не было, в консоли ошибка, которую
 * никто не смотрит. Тест фиксирует три директивы, без которых счётчик умирает.
 *
 * Запуск: `npm test` (или `node --test tests/headers.test.js`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HEADERS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', '_headers');
const RAW = readFileSync(HEADERS, 'utf8');

const csp = RAW.split('\n')
  .find((line) => line.trim().startsWith('Content-Security-Policy:'))
  ?.slice('Content-Security-Policy:'.length)
  .trim();

const directive = (name) =>
  csp
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `)) ?? '';

test('CSP присутствует в public/_headers', () => {
  assert.ok(csp, 'не найдена директива Content-Security-Policy');
});

test('script-src разрешает Метрику — иначе tag.js блокируется', () => {
  assert.match(directive('script-src'), /https:\/\/mc\.yandex\.ru/);
});

test('img-src разрешает пиксель <noscript> Метрики', () => {
  assert.match(directive('img-src'), /https:\/\/mc\.yandex\.ru/);
});

test('connect-src разрешает служебные запросы счётчика', () => {
  assert.match(directive('connect-src'), /https:\/\/mc\.yandex\.ru/);
});

test('CSP по-прежнему запрещает фреймы и плагины', () => {
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

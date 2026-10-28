/**
 * Тест rate limit: реальный IP из заголовков + раздельные баки.
 *
 * Запуск: node server/ratelimit.test.js
 * Зависимостей нет.
 *
 * Этот тест ловит баг, который был в проде 28.10.2026: IP брался из
 * `req.socket.remoteAddress`, который за nginx всегда равен 127.0.0.1 —
 * из-за чего лимит считался общим на всех посетителей сайта.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIpFrom, createRateLimiter } from './ratelimit.js';

/** Собрать минимальный запрос с заданными заголовками и сокетом. */
function makeReq({ headers = {}, remoteAddress = '::ffff:127.0.0.1' } = {}) {
  return { headers, socket: { remoteAddress } };
}

test('clientIpFrom: берёт последний элемент X-Forwarded-For', () => {
  const req = makeReq({ headers: { 'x-forwarded-for': '203.0.113.10, 198.51.100.5' } });
  assert.equal(clientIpFrom(req), '198.51.100.5');
});

test('clientIpFrom: игнорирует подделанный клиентом первый элемент', () => {
  // Клиент прислал свой XFF, nginx дописал настоящий — берём последний.
  const req = makeReq({ headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.99' } });
  assert.equal(clientIpFrom(req), '203.0.113.99');
});

test('clientIpFrom: без заголовка берёт адрес сокета', () => {
  const req = makeReq({ remoteAddress: '::ffff:203.0.113.7' });
  assert.equal(clientIpFrom(req), '::ffff:203.0.113.7');
});

test('clientIpFrom: мусор в заголовке не ломает и не подменяет IP', () => {
  const req = makeReq({
    headers: { 'x-forwarded-for': 'not-an-ip, also-bad' },
    remoteAddress: '::ffff:203.0.113.8',
  });
  assert.equal(clientIpFrom(req), '::ffff:203.0.113.8');
});

test('clientIpFrom: пустой заголовок → адрес сокета', () => {
  const req = makeReq({ headers: { 'x-forwarded-for': '' } });
  assert.equal(clientIpFrom(req), '::ffff:127.0.0.1');
});

test('rate limit: разные IP не блокируют друг друга', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  for (let i = 0; i < 10; i++) {
    assert.equal(limiter.isRateLimited('1.1.1.1', 'lead'), false, `запрос ${i + 1}`);
  }
  assert.equal(limiter.isRateLimited('1.1.1.1', 'lead'), true, '11-й от того же IP — блок');

  // Другой IP должен пройти: это ровно тот сценарий, который ломался в проде.
  assert.equal(limiter.isRateLimited('2.2.2.2', 'lead'), false, 'другой IP не блокируется');
});

test('rate limit: отдельные баки для заявок и чата', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  for (let i = 0; i < 10; i++) {
    limiter.isRateLimited('3.3.3.3', 'chat');
  }
  assert.equal(limiter.isRateLimited('3.3.3.3', 'chat'), true, 'чат исчерпал лимит');
  assert.equal(
    limiter.isRateLimited('3.3.3.3', 'lead'),
    false,
    'форма заявки не должна блокироваться исчерпанным лимитом чата',
  );
});

test('rate limit: окно истекает и IP снова пропускается', () => {
  const limiter = createRateLimiter({ windowMs: 50, max: 2 });
  assert.equal(limiter.isRateLimited('4.4.4.4', 'lead'), false);
  assert.equal(limiter.isRateLimited('4.4.4.4', 'lead'), false);
  assert.equal(limiter.isRateLimited('4.4.4.4', 'lead'), true, 'третий — блок');

  // Ждём истечения окна. Без синхронного ожидания тест был бы flaky.
  const until = Date.now() + 80;
  while (Date.now() < until) {
    /* busy wait — нам нужна реальная задержка, а не таймер в фоне */
  }
  assert.equal(limiter.isRateLimited('4.4.4.4', 'lead'), false, 'после окна IP снова проходит');
});

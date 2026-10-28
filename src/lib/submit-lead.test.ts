/**
 * Тесты отправки заявки: когда повтор помогает, а когда вредит.
 *
 * Запуск: node --test src/lib/submit-lead.test.ts
 * Зависимостей нет.
 *
 * Главный риск, который здесь закрывается: повтор при 5xx отправил бы заявку
 * в Telegram дважды (сервер ответил — значит запрос мог дойти). Проверяем,
 * что повтор делается ТОЛЬКО при сетевой ошибке.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { submitLead } from './submit-lead.ts';

const URL = 'https://primary.example/api/lead/';
const FALLBACK = 'https://backup.example/api/lead/';
const PAYLOAD = { name: 'Иван', contact: '+79990000000', service: 'seo', consent: true };

/** Заглушка fetch: отвечает заданной последовательностью. */
function fakeFetch(steps: Array<{ ok?: boolean; status?: number; throw?: boolean }>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step.throw) throw new Error('network down');
    return new Response('{}', {
      status: step.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('успешный ответ — одна попытка, без повтора', async () => {
  const { impl, calls } = fakeFetch([{ status: 200 }]);
  const result = await submitLead({ url: URL, payload: PAYLOAD, fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.tries, 1);
  assert.equal(result.via, 'primary');
  assert.equal(calls.length, 1);
});

test('сетевая ошибка — уходим на резервный адрес', async () => {
  const { impl, calls } = fakeFetch([{ throw: true }, { status: 200 }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: FALLBACK,
    payload: PAYLOAD,
    fetchImpl: impl,
    retryDelayMs: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.tries, 2);
  assert.equal(result.via, 'fallback');
  assert.deepEqual(calls, [URL, FALLBACK]);
});

test('оба адреса недоступны — ok=false, status=0', async () => {
  const { impl, calls } = fakeFetch([{ throw: true }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: FALLBACK,
    payload: PAYLOAD,
    fetchImpl: impl,
    retryDelayMs: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.tries, 2);
  assert.equal(calls.length, 2);
});

test('400 (невалидная заявка) — резерв не пробуем: вернул бы то же самое', async () => {
  const { impl, calls } = fakeFetch([{ status: 400 }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: FALLBACK,
    payload: PAYLOAD,
    fetchImpl: impl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.tries, 1);
  assert.equal(calls.length, 1, 'на 400 повтор делать нельзя');
});

test('429 (rate limit) — резерв не пробуем: добьём лимит', async () => {
  const { impl, calls } = fakeFetch([{ status: 429 }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: FALLBACK,
    payload: PAYLOAD,
    fetchImpl: impl,
  });
  assert.equal(result.status, 429);
  assert.equal(calls.length, 1);
});

test('404 — резерв не пробуем: адрес неверный', async () => {
  const { impl, calls } = fakeFetch([{ status: 404 }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: FALLBACK,
    payload: PAYLOAD,
    fetchImpl: impl,
  });
  assert.equal(result.status, 404);
  assert.equal(calls.length, 1);
});

test('500 — резерв НЕ пробуем: заявка могла уйти, повтор = дубль', async () => {
  const { impl, calls } = fakeFetch([{ status: 500 }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: FALLBACK,
    payload: PAYLOAD,
    fetchImpl: impl,
    retryDelayMs: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(calls.length, 1, 'на 5xx повтор запрещён — будет дубль заявки');
});

test('тело запроса — JSON с теми же данными', async () => {
  let captured: RequestInit | undefined;
  const impl = (async (_url: string, init?: RequestInit) => {
    captured = init;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  await submitLead({ url: URL, payload: PAYLOAD, fetchImpl: impl });
  assert.equal(captured?.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured?.body)), PAYLOAD);
  const headers = captured?.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/json');
});

test('таймаут запроса не оставляет висящий сервер', async () => {
  const impl = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as unknown as typeof fetch;

  const result = await submitLead({
    url: URL,
    payload: PAYLOAD,
    fetchImpl: impl,
    timeoutMs: 50,
    retryDelayMs: 1,
    attempts: 1,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});

test('одинаковые адреса не дублируются', async () => {
  const { impl, calls } = fakeFetch([{ throw: true }]);
  const result = await submitLead({
    url: URL,
    fallbackUrl: URL,
    payload: PAYLOAD,
    fetchImpl: impl,
    retryDelayMs: 1,
  });
  assert.equal(calls.length, 1, 'один и тот же адрес не пробуем дважды');
  assert.equal(result.tries, 1);
});

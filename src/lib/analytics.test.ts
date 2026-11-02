import assert from 'node:assert/strict';
import test from 'node:test';

import { __resetGoals, reachGoal } from './analytics.ts';

type Call = [number, string, string, unknown?];

const stubWindow = (counterId?: number) => {
  const calls: Call[] = [];
  const win = {
    __ymCounterId: counterId,
    ym: (id: number, action: string, goal?: string, params?: unknown) => {
      calls.push([id, action, goal as string, params]);
    },
  };
  (globalThis as unknown as { window: typeof win }).window = win;
  return calls;
};

test('без счётчика цель не отправляется и не падает', () => {
  __resetGoals();
  stubWindow(undefined);
  assert.equal(reachGoal('lead_submit'), false);
});

test('со счётчиком уходит reachGoal с номером счётчика', () => {
  __resetGoals();
  const calls = stubWindow(123456);
  assert.equal(reachGoal('phone_click', { page: '/' }), true);
  assert.deepEqual(calls, [[123456, 'reachGoal', 'phone_click', { page: '/' }]]);
});

test('once отправляет цель один раз за страницу', () => {
  __resetGoals();
  const calls = stubWindow(123456);
  assert.equal(reachGoal('chat_open', undefined, { once: true }), true);
  assert.equal(reachGoal('chat_open', undefined, { once: true }), false);
  assert.equal(calls.length, 1);
});

test('без once цель повторяется (каждый клик по телефону)', () => {
  __resetGoals();
  const calls = stubWindow(123456);
  reachGoal('phone_click');
  reachGoal('phone_click');
  assert.equal(calls.length, 2);
});

test('ym, упавший до загрузки счётчика, не ломает страницу', () => {
  __resetGoals();
  (globalThis as unknown as { window: Record<string, unknown> }).window = { __ymCounterId: 1 };
  assert.equal(reachGoal('scroll_75'), false);
});

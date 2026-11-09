import assert from 'node:assert/strict';
import test from 'node:test';

import { UTM_KEY, currentUtm, parseUtm, rememberUtm } from './utm.ts';

/** Минимальное хранилище вместо sessionStorage: тот же интерфейс. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  } as unknown as Storage & { map: Map<string, string> };
}

test('parseUtm: разбирает source, campaign и content', () => {
  const utm = parseUtm('?utm_source=telegram&utm_campaign=crm-i-erp-raznica&utm_content=post-1');
  assert.deepEqual(utm, {
    source: 'telegram',
    campaign: 'crm-i-erp-raznica',
    content: 'post-1',
  });
});

test('parseUtm: пустые и чужие параметры не попадают в результат', () => {
  assert.deepEqual(parseUtm('?utm_source=&utm_campaign=vk'), { campaign: 'vk' });
  assert.deepEqual(parseUtm('?page=2'), {});
  assert.deepEqual(parseUtm(''), {});
});

test('parseUtm: обрезает длинные значения', () => {
  const utm = parseUtm(`?utm_campaign=${'a'.repeat(200)}`);
  assert.equal(utm.campaign?.length, 80);
});

test('rememberUtm: сохраняет метки первого захода', () => {
  const storage = fakeStorage();
  const utm = rememberUtm(storage, '?utm_source=telegram&utm_campaign=kontent-plan');

  assert.deepEqual(utm, { source: 'telegram', campaign: 'kontent-plan' });
  assert.equal(storage.map.has(UTM_KEY), true);
});

test('rememberUtm: не перезаписывает источник при переходах внутри сайта', () => {
  const storage = fakeStorage();
  rememberUtm(storage, '?utm_source=telegram&utm_campaign=kontent-plan');

  // Вторая страница пришла без меток — источник должен остаться прежним.
  assert.deepEqual(rememberUtm(storage, ''), {
    source: 'telegram',
    campaign: 'kontent-plan',
  });

  // Третья — с другими метками: first-touch тоже не меняется.
  assert.deepEqual(rememberUtm(storage, '?utm_source=vk&utm_campaign=other'), {
    source: 'telegram',
    campaign: 'kontent-plan',
  });
});

test('rememberUtm: без меток ничего не пишет', () => {
  const storage = fakeStorage();
  assert.deepEqual(rememberUtm(storage, '?page=2'), {});
  assert.equal(storage.map.has(UTM_KEY), false);
});

test('rememberUtm: переживает недоступное хранилище', () => {
  const broken = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
  } as unknown as Storage;

  assert.deepEqual(rememberUtm(broken, '?utm_source=telegram'), { source: 'telegram' });
});

test('currentUtm: читает сохранённые метки и терпит мусор в хранилище', () => {
  const storage = fakeStorage();
  rememberUtm(storage, '?utm_source=telegram&utm_campaign=voronka');
  assert.deepEqual(currentUtm(storage), { source: 'telegram', campaign: 'voronka' });

  const garbage = fakeStorage({ [UTM_KEY]: 'не json' });
  assert.deepEqual(currentUtm(garbage), {});

  const wrongShape = fakeStorage({ [UTM_KEY]: '["telegram"]' });
  assert.deepEqual(currentUtm(wrongShape), {});

  const unknownField = fakeStorage({ [UTM_KEY]: '{"source":"telegram","evil":"x"}' });
  assert.deepEqual(currentUtm(unknownField), { source: 'telegram' });
});

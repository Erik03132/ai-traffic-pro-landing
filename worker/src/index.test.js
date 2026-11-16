/**
 * Тесты Cloudflare Worker: роутинг, CORS, обработчики заявки и чата.
 *
 * Запуск: node --test worker/src/index.test.js
 * Зависимостей нет.
 *
 * Зачем: Worker — основной путь API, и в нём есть тот же класс ошибок, что
 * снёс VPS 28.10 (потерянная функция CORS роняла каждый запрос, а модульные
 * тесты этого не видели). Здесь Worker поднимается как обычная функция —
 * mock'иваем `env` (KV, Workers AI, rate limit) и проверяем то, что видит
 * клиент: коды ответов, заголовки CORS, валидацию заявки, ответ по базе
 * знаний.
 *
 * Telegram в тестах не вызывается: `TELEGRAM_BOT_TOKEN` пустой, заявка
 * сохраняется только в mock-KV.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';

const ORIGIN = 'https://ai-traffic-pro.ru';
const ALLOWED_ORIGINS = `${ORIGIN},https://www.ai-traffic-pro.ru`;

/** Mock KV: пишет в массив, чтобы проверять бэкап заявок. */
function mockKv() {
  const store = new Map();
  return {
    store,
    async put(key, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async delete(key) {
      store.delete(key);
    },
    /** `list` как у настоящего KV: префикс + постраничная выдача. */
    async list({ prefix = '', cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const page = names.slice(from, from + 100);
      const complete = from + 100 >= names.length;
      return {
        keys: page.map((name) => ({ name })),
        list_complete: complete,
        cursor: complete ? undefined : String(from + 100),
      };
    },
  };
}

/** Mock Workers AI: возвращает заранее заданный ответ. */
function mockAi(reply = 'Ответ модели') {
  return {
    async run(model, options) {
      return { response: reply, model, options };
    },
  };
}

/** Rate limit binding: всегда разрешает (проверка 429 — отдельным тестом). */
function mockLimiter(success = true) {
  return {
    async limit() {
      return { success };
    },
  };
}

/**
 * Окружение Worker для тестов.
 * @param {{kv?: boolean, ai?: unknown, limiterOk?: boolean, token?: string}} opts
 */
function makeEnv(opts = {}) {
  return {
    ALLOWED_ORIGINS,
    TELEGRAM_BOT_TOKEN: opts.token ?? '',
    TELEGRAM_CHAT_ID: opts.token ? '123' : '',
    LEADS: opts.kv === false ? undefined : mockKv(),
    AI: opts.ai ?? mockAi(),
    CHAT_LIMITER: mockLimiter(opts.limiterOk ?? true),
    LEAD_LIMITER: mockLimiter(opts.limiterOk ?? true),
  };
}

/**
 * Вызывает Worker как это делает платформа.
 * @param {string} path путь, например '/api/chat/'
 * @param {RequestInit} init
 * @param {Record<string, unknown>} env
 */
async function call(path, init = {}, env = makeEnv()) {
  const request = new Request(`https://api.ai-traffic-pro.ru${path}`, init);
  const response = await worker.fetch(request, env);
  return response;
}

/** POST c JSON-телом. */
function post(body, headers = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
test('GET /api/health отвечает 200 и рапортует о настройке', async () => {
  const env = makeEnv();
  const res = await call('/api/health', {}, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.telegram, false, 'Telegram в тесте не настроен');
  assert.equal(data.ai, true);
});

test('health с настроенным Telegram рапортует telegram: true', async () => {
  const res = await call('/api/health', {}, makeEnv({ token: 'test-token' }));
  const data = await res.json();
  assert.equal(data.telegram, true);
});

test('OPTIONS отдаёт 204 с CORS-заголовками для разрешённого origin', async () => {
  const res = await call('/api/chat/', { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('чужой origin не получает CORS-заголовков', async () => {
  const res = await call(
    '/api/chat/',
    post({ message: 'сколько стоит' }, { Origin: 'https://evil.example' }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('обычный POST-ответ несёт CORS-заголовки разрешённого origin', async () => {
  // Отдельно от OPTIONS: заголовки на 204 и на 200-ответе с телом ставятся
  // разными путями (corsHeaders() напрямую vs json()). Проверяем оба.
  const res = await call(
    '/api/chat/',
    post({ message: 'сколько стоит' }, { Origin: ORIGIN }),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('ошибочный ответ (400) тоже несёт CORS-заголовки', async () => {
  // Без этого браузер покажет клиенту «сетевую ошибку» вместо сообщения
  // о невалидной заявке — заголовки нужны на каждом ответе.
  const res = await call(
    '/api/lead/',
    post({ name: 'И', contact: '1', service: '', consent: false }, { Origin: ORIGIN }),
  );
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
});

test('несуществующий путь → 404', async () => {
  const res = await call('/nope/', {});
  assert.equal(res.status, 404);
});

test('GET на /api/chat → 404 (метод не тот)', async () => {
  const res = await call('/api/chat/', {});
  assert.equal(res.status, 404);
});

test('битый JSON → 400', async () => {
  const res = await call('/api/chat/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{не json',
  });
  assert.equal(res.status, 400);
});

test('пустое сообщение в чат → 400', async () => {
  const res = await call('/api/chat/', post({ message: '   ' }));
  assert.equal(res.status, 400);
});

test('чат отвечает по базе знаний без вызова LLM', async () => {
  let aiCalled = false;
  const env = makeEnv({
    ai: {
      async run() {
        aiCalled = true;
        return { response: 'ответ модели' };
      },
    },
  });
  const res = await call('/api/chat/', post({ message: 'сколько стоит' }), env);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, 'knowledge');
  assert.match(data.reply, /по запросу/);
  assert.equal(aiCalled, false, 'на вопрос из базы знаний LLM не зовём');
});

test('вопрос вне базы знаний → LLM', async () => {
  const res = await call(
    '/api/chat/',
    post({ message: 'какой у вас офисный график в четверг' }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, 'llm');
  assert.ok(data.reply.length > 0);
});

test('падение Workers AI → ответ по fallback, не 500', async () => {
  const env = makeEnv({
    ai: {
      async run() {
        throw new Error('Workers AI недоступен');
      },
    },
  });
  const res = await call(
    '/api/chat/',
    post({ message: 'какой у вас офисный график в четверг' }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, 'fallback');
  assert.ok(data.reply.length > 0);
});

test('заявка без согласия → 400 со списком ошибок', async () => {
  const res = await call(
    '/api/lead/',
    post({ name: 'И', contact: '1', service: '', consent: false }),
  );
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.ok(data.errors.includes('consent'), 'требуется согласие на обработку ПДн');
});

test('корректная заявка → 200 и бэкап в KV до отправки в Telegram', async () => {
  const env = makeEnv();
  const res = await call(
    '/api/lead/',
    post({
      name: 'Иван',
      contact: '+79990000000',
      service: 'seo',
      business: '',
      comment: 'нужен аудит',
      source: '/',
      consent: true,
    }),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);

  // Заявка сохранена в KV — она не потеряется, даже если Telegram молчит.
  assert.equal(env.LEADS.store.size, 1, 'заявка должна быть в KV');
  const saved = JSON.parse([...env.LEADS.store.values()][0]);
  assert.equal(saved.name, 'Иван');
  assert.equal(saved.service, 'seo');
  assert.ok(saved.receivedAt, 'есть метка времени приёма');
});

test('honeypot: заявка от бота не попадает ни в KV, ни в Telegram', async () => {
  const env = makeEnv();
  const res = await call(
    '/api/lead/',
    post({
      name: 'Бот',
      contact: 'bot@spam.example',
      service: 'seo',
      consent: true,
      website: 'http://spam.example',
    }),
    env,
  );
  // Боту отвечаем «успех», чтобы он не подбирал ввод.
  assert.equal(res.status, 200);
  assert.equal(env.LEADS.store.size, 0, 'заявка от бота не сохраняется');
});

test('rate limit: при превышении → 429', async () => {
  const env = makeEnv({ limiterOk: false });
  const res = await call('/api/chat/', post({ message: 'сколько стоит' }), env);
  assert.equal(res.status, 429);
  const data = await res.json();
  assert.equal(data.error, 'rate limit');
});

test('rate limit: баки чата и заявок раздельные', async () => {
  // Отдельные binding'и: если чат исчерпал лимит, заявки не должны страдать.
  const env = makeEnv();
  env.CHAT_LIMITER = mockLimiter(false);
  env.LEAD_LIMITER = mockLimiter(true);

  const chat = await call('/api/chat/', post({ message: 'сколько стоит' }), env);
  assert.equal(chat.status, 429);

  const lead = await call(
    '/api/lead/',
    post({
      name: 'Иван',
      contact: '+79990000000',
      service: 'seo',
      consent: true,
    }),
    env,
  );
  assert.equal(lead.status, 200);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Бот: диплинк-метка (`?start=`) и вопросы клиента
 * ────────────────────────────────────────────────────────────────────────── */

/** Апдейт «сообщение боту» в личном чате. */
function tgMessage(text, { userId = 555, chatType = 'private', username = 'client' } = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1762000000,
      chat: { id: userId, type: chatType },
      from: { id: userId, is_bot: false, first_name: 'Клиент', username },
      text,
    },
  };
}

/** Окружение с секретом вебхука и токеном отчёта. */
function botEnv() {
  const env = makeEnv();
  env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret';
  env.TG_PUBLISH_TOKEN = 'report-token';
  env.SITE_URL = 'https://ai-traffic-pro.ru';
  return env;
}

/** POST вебхука с секретом Telegram. */
function tgPost(update, secret = 'hook-secret') {
  return post(update, { 'X-Telegram-Bot-Api-Secret-Token': secret });
}

test('webhook: без секрета → 401 и метка не пишется', async () => {
  const env = botEnv();
  const res = await call('/api/tg/webhook/', post(tgMessage('/start ai_traffic_pro')), env);
  assert.equal(res.status, 401);
  assert.equal(env.LEADS.store.size, 0);
});

test('webhook: /start с меткой пишет первый источник', async () => {
  const env = botEnv();
  const res = await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro')), env);
  assert.equal(res.status, 200);

  const record = JSON.parse(env.LEADS.store.get('ref:555'));
  assert.equal(record.label, 'ai_traffic_pro');
  assert.equal(record.user_id, 555);
  assert.equal(record.username, 'client');
});

test('webhook: повторный /start не затирает первый источник', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro')), env);
  await call('/api/tg/webhook/', tgPost(tgMessage('/start yandex_direct')), env);

  const record = JSON.parse(env.LEADS.store.get('ref:555'));
  assert.equal(record.label, 'ai_traffic_pro');
});

test('webhook: /start без метки → direct', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start')), env);
  assert.equal(JSON.parse(env.LEADS.store.get('ref:555')).label, 'direct');
});

test('webhook: /start@bot с меткой тоже распознаётся', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start@aitraffic_publish_bot ai_traffic_pro')), env);
  assert.equal(JSON.parse(env.LEADS.store.get('ref:555')).label, 'ai_traffic_pro');
});

test('webhook: имя бота в /start@ не важно — метка отделяется', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start@some_other_bot yandex')), env);
  assert.equal(JSON.parse(env.LEADS.store.get('ref:555')).label, 'yandex');
});

/** Ключи источников в mock-KV: `dbg:` (диагностика) не в счёт. */
function refKeys(env) {
  return [...env.LEADS.store.keys()].filter((k) => k.startsWith('ref:'));
}

test('webhook: вопрос клиента не создаёт запись источника', async () => {
  const env = botEnv();
  const res = await call('/api/tg/webhook/', tgPost(tgMessage('Сколько стоит продвижение?')), env);
  assert.equal(res.status, 200);
  assert.deepEqual(refKeys(env), []);
});

test('webhook: сообщение из группы игнорируется', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro', { chatType: 'group' })), env);
  assert.deepEqual(refKeys(env), []);
});

test('webhook: диагностическая запись пишется на каждый апдейт', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro')), env);

  const keys = [...env.LEADS.store.keys()].filter((k) => k.startsWith('dbg:'));
  assert.deepEqual(keys, ['dbg:last'], 'держим один ключ-последний, а не по ключу на апдейт');
  assert.equal(JSON.parse(env.LEADS.store.get('dbg:last')).chat, 'private');
});

test('GET /api/tg/sources: без токена → 401', async () => {
  const env = botEnv();
  const res = await call('/api/tg/sources', {}, env);
  assert.equal(res.status, 401);
});

test('GET /api/tg/sources: считает по меткам', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro', { userId: 1 })), env);
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro', { userId: 2 })), env);
  await call('/api/tg/webhook/', tgPost(tgMessage('/start yandex_direct', { userId: 3 })), env);
  await call('/api/tg/webhook/', tgPost(tgMessage('/start', { userId: 4 })), env);

  const res = await call(
    '/api/tg/sources',
    { headers: { Authorization: 'Bearer report-token' } },
    env,
  );
  assert.equal(res.status, 200);

  const data = await res.json();
  assert.equal(data.total, 4);
  assert.equal(data.returning, 0);
  assert.deepEqual(data.sources, [
    { label: 'ai_traffic_pro', count: 2 },
    { label: 'direct', count: 1 },
    { label: 'yandex_direct', count: 1 },
  ]);
  assert.deepEqual(data.lastTouch, []);
});

test('GET /api/tg/sources: lastTouch показывает возвраты из кампаний', async () => {
  const env = botEnv();
  // Первый вход — прямой, потом человек вернулся по рекламной метке.
  await call('/api/tg/webhook/', tgPost(tgMessage('/start', { userId: 1 })), env);
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro', { userId: 1 })), env);
  // Второй пользователь пришёл по метке сразу: первое касание = реклама.
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro', { userId: 2 })), env);

  const res = await call(
    '/api/tg/sources',
    { headers: { Authorization: 'Bearer report-token' } },
    env,
  );
  const data = await res.json();

  assert.equal(data.total, 2);
  // Возврат считается один: у второго пользователя last_label нет.
  assert.equal(data.returning, 1);
  assert.deepEqual(data.sources, [
    { label: 'ai_traffic_pro', count: 1 },
    { label: 'direct', count: 1 },
  ]);
  assert.deepEqual(data.lastTouch, [{ label: 'ai_traffic_pro', count: 1 }]);
});

test('webhook: повторный вход из кампании пишет last_label, первый остаётся', async () => {
  const env = botEnv();
  await call('/api/tg/webhook/', tgPost(tgMessage('/start ai_traffic_pro')), env);
  await call('/api/tg/webhook/', tgPost(tgMessage('/start yandex_direct')), env);

  const record = JSON.parse(env.LEADS.store.get('ref:555'));
  assert.equal(record.label, 'ai_traffic_pro', 'первый источник не меняется');
  assert.equal(record.last_label, 'yandex_direct', 'последнее касание фиксируется');
});

/* ── След публикации: GET /api/tg/last ─────────────────────────────────── */

test('GET /api/tg/last: без токена → 401', async () => {
  const res = await call('/api/tg/last', {}, makeEnv());
  assert.equal(res.status, 401);
});

test('GET /api/tg/last: пустая история → null, а не ошибка', async () => {
  const env = makeEnv();
  env.TG_PUBLISH_TOKEN = 'pub-token';

  const res = await call('/api/tg/last', { headers: { Authorization: 'Bearer pub-token' } }, env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { publish: null, update: null });
});

test('GET /api/tg/last: отдаёт последнюю публикацию и последний апдейт', async () => {
  const env = makeEnv();
  env.TG_PUBLISH_TOKEN = 'pub-token';
  await env.LEADS.put('pub:last', JSON.stringify({ slug: 'test', message_id: 42 }));
  await env.LEADS.put('dbg:last', JSON.stringify({ kind: 'callback_query' }));

  const res = await call('/api/tg/last', { headers: { Authorization: 'Bearer pub-token' } }, env);
  const data = await res.json();
  assert.equal(data.publish.slug, 'test');
  assert.equal(data.publish.message_id, 42);
  assert.equal(data.update.kind, 'callback_query');
});

test('webhook: успешная публикация пишет pub:last и убирает черновик', async () => {
  const env = makeEnv({ token: 'test-token' });
  env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret';
  env.TELEGRAM_CHANNEL_ID = '@aitrafficpro';

  const link = 'https://ai-traffic-pro.ru/blog/test/?utm_source=telegram';
  await env.LEADS.put(
    'draft:tg:test',
    JSON.stringify({ html: '<b>Пост</b>', linkUrl: link }),
  );

  const realFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url) => {
    methods.push(String(url).split('/').pop());
    return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  let res;
  try {
    res = await call(
      '/api/tg/webhook/',
      {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
        body: JSON.stringify({
          update_id: 10,
          callback_query: {
            id: 'q1',
            data: 'tgpub:test',
            message: { message_id: 5, chat: { id: '123' } },
          },
        }),
      },
      env,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(res.status, 200);
  assert.ok(methods.includes('sendMessage'), 'пост должен уйти в канал');
  assert.equal(env.LEADS.store.get('draft:tg:test'), undefined, 'черновик удаляется');

  const saved = JSON.parse(env.LEADS.store.get('pub:last'));
  assert.equal(saved.slug, 'test');
  assert.equal(saved.message_id, 777);
  assert.equal(saved.link, link);
  assert.ok(saved.ts, 'время публикации записано');
});

test('webhook: неудачная отправка не пишет pub:last', async () => {
  const env = makeEnv({ token: 'test-token' });
  env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret';
  env.TELEGRAM_CHANNEL_ID = '@aitrafficpro';
  await env.LEADS.put(
    'draft:tg:test',
    JSON.stringify({ html: '<b>Пост</b>', linkUrl: 'https://ai-traffic-pro.ru/blog/test/' }),
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  let res;
  try {
    res = await call(
      '/api/tg/webhook/',
      {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
        body: JSON.stringify({
          update_id: 11,
          callback_query: {
            id: 'q2',
            data: 'tgpub:test',
            message: { message_id: 6, chat: { id: '123' } },
          },
        }),
      },
      env,
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(res.status, 502);
  assert.equal(env.LEADS.store.get('pub:last'), undefined, 'ложный след публикации не пишем');
  assert.ok(env.LEADS.store.get('draft:tg:test'), 'черновик остаётся, можно повторить');
});

/* ──────────────────────────────────────────────────────────────────────────
 * Лог вопросов из виджета (16.11.2026)
 *
 * Виджет отвечает сам и ничего не помнит: без лога владелец не видит, о чём
 * спрашивают, а «сколько стоит» — это лид, не дошедший до формы.
 * ────────────────────────────────────────────────────────────────────────── */

/** Подмена Telegram: собирает тексты отправленных сообщений. */
function captureTelegram() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url).split('/').pop(), text: JSON.parse(init.body).text });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { sent, restore: () => (globalThis.fetch = realFetch) };
}

/** Ключи лога вопросов в mock-KV. */
function chatKeys(env) {
  return [...env.LEADS.store.keys()].filter((k) => k.startsWith('chat:q:'));
}

test('chat: вопрос попадает в лог, ответ не зависит от Telegram', async () => {
  const env = makeEnv();
  const res = await call('/api/chat', post({ message: 'Что такое GEO?' }), env);
  assert.equal(res.status, 200);

  const keys = chatKeys(env);
  assert.equal(keys.length, 1, 'вопрос должен записаться в KV');

  const record = JSON.parse(env.LEADS.store.get(keys[0]));
  assert.equal(record.q, 'Что такое GEO?');
  assert.ok(record.source, 'источник ответа сохранён');
  assert.ok(record.ts, 'время сохранено');
});

test('chat: горячий вопрос уходит владельцу в Telegram со страницей', async () => {
  const env = makeEnv({ token: 'test-token' });
  const tg = captureTelegram();
  let body;
  try {
    const res = await call(
      '/api/chat',
      post({
        message: 'Сколько стоит продвижение в Яндекс Директе?',
        context: { page: '/services/advertising/', source: 'widget' },
      }),
      env,
    );
    body = await res.json();
  } finally {
    tg.restore();
  }

  assert.equal(body.askContact, true, 'на горячий вопрос виджет спрашивает контакт');
  assert.equal(tg.sent.length, 1, 'горячий вопрос уведомляет сразу');
  assert.equal(tg.sent[0].url, 'sendMessage');
  assert.match(tg.sent[0].text, /Сколько стоит/);
  assert.match(tg.sent[0].text, /Страница: \/services\/advertising\//);

  const record = JSON.parse(env.LEADS.store.get(chatKeys(env)[0]));
  assert.equal(record.page, '/services/advertising/', 'страница сохраняется в логе');
});

test('chat: обычный вопрос владельцу не уходит и контакт не просит', async () => {
  const env = makeEnv({ token: 'test-token' });
  const tg = captureTelegram();
  let body;
  try {
    const res = await call('/api/chat', post({ message: 'Чем отличается CRM от ERP?' }), env);
    body = await res.json();
  } finally {
    tg.restore();
  }

  assert.equal(body.askContact, false);
  assert.equal(tg.sent.length, 0, 'не каждый вопрос будильник');
  assert.equal(chatKeys(env).length, 1, 'но в лог он всё равно попадает');
});

test('chat: потолок пушей в час не пробивается', async () => {
  const env = makeEnv({ token: 'test-token' });
  const hour = new Date().toISOString().slice(0, 13);
  await env.LEADS.put(`chat:hot:${hour}`, '20');

  const tg = captureTelegram();
  try {
    await call('/api/chat', post({ message: 'Нужна цена и сроки' }), env);
  } finally {
    tg.restore();
  }

  assert.equal(tg.sent.length, 0, 'после 20 пушей в час — только лог');
});

test('GET /api/chat/log: без токена → 401', async () => {
  const res = await call('/api/chat/log', {}, makeEnv());
  assert.equal(res.status, 401);
});

test('GET /api/chat/log: отдаёт новые вопросы первыми', async () => {
  const env = makeEnv();
  env.TG_PUBLISH_TOKEN = 'report-token';
  await env.LEADS.put(
    'chat:q:2026-11-15T09:00:00.000Z:aaaa1111',
    JSON.stringify({ q: 'старый вопрос', source: 'llm', ts: '2026-11-15T09:00:00.000Z' }),
  );
  await env.LEADS.put(
    'chat:q:2026-11-16T09:00:00.000Z:bbbb2222',
    JSON.stringify({ q: 'новый вопрос', source: 'knowledge', ts: '2026-11-16T09:00:00.000Z' }),
  );

  const res = await call(
    '/api/chat/log',
    { headers: { Authorization: 'Bearer report-token' } },
    env,
  );
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.total, 2);
  assert.deepEqual(
    data.items.map((i) => i.q),
    ['новый вопрос', 'старый вопрос'],
  );
});

test('cron: дайджест шлёт топ вопросов за сутки, пустой день молчит', async () => {
  const env = makeEnv({ token: 'test-token' });
  const fresh = new Date().toISOString();
  await env.LEADS.put(
    `chat:q:${fresh}:cccc3333`,
    JSON.stringify({ q: 'Сколько стоит сайт?', source: 'llm', ts: fresh }),
  );
  await env.LEADS.put(
    `chat:q:${fresh}:dddd4444`,
    JSON.stringify({ q: 'Сколько стоит сайт?', source: 'llm', ts: fresh }),
  );
  // Старше суток — в дайджест не попадает.
  await env.LEADS.put(
    'chat:q:2026-01-01T00:00:00.000Z:eeee5555',
    JSON.stringify({ q: 'древний вопрос', source: 'llm', ts: '2026-01-01T00:00:00.000Z' }),
  );

  const tg = captureTelegram();
  try {
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    tg.restore();
  }

  assert.equal(tg.sent.length, 1);
  assert.match(tg.sent[0].text, /за сутки: 2/);
  assert.match(tg.sent[0].text, /2× сколько стоит сайт\?/);
  assert.doesNotMatch(tg.sent[0].text, /древний/);
});

test('cron: пустой день — сообщение не отправляется', async () => {
  const env = makeEnv({ token: 'test-token' });
  const tg = captureTelegram();
  try {
    const pending = [];
    await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally {
    tg.restore();
  }

  assert.equal(tg.sent.length, 0);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Ответ в логе и читаемый вид (16.11.2026)
 *
 * Вопрос без ответа отвечает на «о чём спрашивают», но не на «что человек
 * ушёл читать». Ответ пишется в ту же запись — записей от этого не больше.
 * ────────────────────────────────────────────────────────────────────────── */

test('chat: ответ сохраняется вместе с вопросом', async () => {
  const env = makeEnv();
  await call('/api/chat', post({ message: 'Что такое GEO?' }), env);

  const record = JSON.parse(env.LEADS.store.get(chatKeys(env)[0]));
  assert.ok(record.a, 'ответ записан в ту же запись');
  assert.ok(record.a.length > 10, 'ответ не пустая заглушка');
  assert.equal(record.a, record.a.slice(0, 1000), 'длинный ответ обрезается до 1000 символов');
});

test('GET /api/chat/log?format=text: диалог «вопрос → ответ»', async () => {
  const env = makeEnv();
  env.TG_PUBLISH_TOKEN = 'report-token';
  await env.LEADS.put(
    'chat:q:2026-11-16T09:00:00.000Z:aaaa1111',
    JSON.stringify({
      q: 'Сколько стоит сайт?',
      a: 'Стоимость — по запросу.',
      source: 'knowledge',
      page: '/services/web/',
      ts: '2026-11-16T09:00:00.000Z',
    }),
  );
  await env.LEADS.put(
    'chat:q:2026-11-16T10:00:00.000Z:bbbb2222',
    JSON.stringify({
      q: 'Чем отличается CRM от ERP?',
      a: 'CRM про клиентов, ERP про ресурсы.',
      source: 'llm',
      ts: '2026-11-16T10:00:00.000Z',
    }),
  );

  const res = await call(
    '/api/chat/log?format=text',
    { headers: { Authorization: 'Bearer report-token' } },
    env,
  );
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /text\/plain/);
  assert.match(body, /Вопросы из виджета — 2/);
  assert.match(body, /\? Сколько стоит сайт\?/);
  assert.match(body, /→ Стоимость — по запросу\./);
  assert.match(body, /база знаний/);
  assert.match(body, /модель/);

  // Внутри дня — по времени вверх: диалог читается как диалог.
  assert.ok(body.indexOf('Сколько стоит сайт?') < body.indexOf('Чем отличается CRM'));
  // 12:00 МСК, а не 09:00 UTC.
  assert.match(body, /12:00/);
});

test('GET /api/chat/log?format=text&day=: только указанный день по Москве', async () => {
  const env = makeEnv();
  env.TG_PUBLISH_TOKEN = 'report-token';
  // 21:30 UTC 16-го = 00:30 МСК 17-го: по Москве это уже следующий день,
  // хотя по UTC — ещё 16-е. Именно здесь ошибается наивный фильтр по UTC.
  await env.LEADS.put(
    'chat:q:2026-11-16T21:30:00.000Z:cccc3333',
    JSON.stringify({ q: 'поздний вопрос', a: 'ответ', source: 'llm', ts: '2026-11-16T21:30:00.000Z' }),
  );
  await env.LEADS.put(
    'chat:q:2026-11-16T09:00:00.000Z:dddd4444',
    JSON.stringify({ q: 'дневной вопрос', a: 'ответ', source: 'llm', ts: '2026-11-16T09:00:00.000Z' }),
  );

  const res = await call(
    '/api/chat/log?format=text&day=2026-11-16',
    { headers: { Authorization: 'Bearer report-token' } },
    env,
  );
  const body = await res.text();

  assert.match(body, /16\.11\.2026/);
  assert.match(body, /дневной вопрос/);
  assert.doesNotMatch(body, /поздний вопрос/);
});

test('GET /api/chat/log?format=text: пустой день говорит «пусто», а не молчит', async () => {
  const env = makeEnv();
  env.TG_PUBLISH_TOKEN = 'report-token';

  const res = await call(
    '/api/chat/log?format=text&day=2026-01-01',
    { headers: { Authorization: 'Bearer report-token' } },
    env,
  );

  assert.equal(res.status, 200);
  assert.match(await res.text(), /пусто/);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Пост с картинкой (17.11.2026)
 *
 * Статьи блога переупаковываются в посты канала. Текст в ленте короткий, и
 * пост с обложкой заметнее — но у подписи к фото свой лимит (1024 знака),
 * и публиковать нужно тем же способом, каким черновик пришёл владельцу.
 * ────────────────────────────────────────────────────────────────────────── */

/** Подмена Telegram: запоминает метод и тело каждого запроса. */
function captureCalls() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

/** Среда для превью: токен публикации и канал настроены. */
function previewEnv() {
  const env = makeEnv({ token: 'test-token' });
  env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret';
  env.TG_PUBLISH_TOKEN = 'report-token';
  env.SITE_URL = 'https://ai-traffic-pro.ru';
  env.TELEGRAM_CHANNEL_ID = '@aitrafficpro';
  return env;
}

const PREVIEW_AUTH = { Authorization: 'Bearer report-token' };

test('preview: с картинкой уходит sendPhoto с подписью и кнопками', async () => {
  const env = previewEnv();
  const tg = captureCalls();
  let data;
  try {
    const res = await call(
      '/api/tg/preview',
      post(
        {
          slug: 'test',
          text: 'Окупаемость рекламы считают до запуска, а не после.',
          photo: 'https://ai-traffic-pro.ru/blog/test.jpg',
        },
        PREVIEW_AUTH,
      ),
      env,
    );
    data = await res.json();
  } finally {
    tg.restore();
  }

  assert.equal(data.ok, true);
  const sent = tg.calls.find((c) => c.method === 'sendPhoto');
  assert.ok(sent, 'пост с картинкой уходит как фото');
  assert.equal(sent.body.photo, 'https://ai-traffic-pro.ru/blog/test.jpg');
  assert.match(sent.body.caption, /Окупаемость рекламы/);
  assert.match(sent.body.caption, /Черновик поста/);
  assert.match(sent.body.reply_markup.inline_keyboard[0][0].callback_data, /tgpub:test/);

  // Черновик запомнил картинку: иначе «Опубликовать» потеряет фото.
  const draft = JSON.parse(env.LEADS.store.get('draft:tg:test'));
  assert.equal(draft.photo, 'https://ai-traffic-pro.ru/blog/test.jpg');
});

test('preview: без картинки остаётся обычным сообщением', async () => {
  const env = previewEnv();
  const tg = captureCalls();
  try {
    await call(
      '/api/tg/preview',
      post({ slug: 'test', text: 'Пост без картинки' }, PREVIEW_AUTH),
      env,
    );
  } finally {
    tg.restore();
  }

  assert.equal(tg.calls.some((c) => c.method === 'sendPhoto'), false);
  const sent = tg.calls.find((c) => c.method === 'sendMessage');
  assert.ok(sent, 'без картинки — обычный текст');
  assert.match(sent.body.text, /Пост без картинки/);
  assert.equal(JSON.parse(env.LEADS.store.get('draft:tg:test')).photo, '');
});

test('preview: плохой адрес картинки — 400, в Telegram не уходит', async () => {
  const env = previewEnv();
  const tg = captureCalls();
  let res;
  try {
    res = await call(
      '/api/tg/preview',
      post({ slug: 'test', text: 'Пост', photo: 'blog/test.jpg' }, PREVIEW_AUTH),
      env,
    );
  } finally {
    tg.restore();
  }

  assert.equal(res.status, 400);
  assert.equal(tg.calls.length, 0);
});

test('preview: текст длиннее подписи к фото — 400 с причиной, а не отказ Telegram', async () => {
  const env = previewEnv();
  const tg = captureCalls();
  let res;
  let data;
  try {
    res = await call(
      '/api/tg/preview',
      post(
        {
          slug: 'test',
          text: 'Слово '.repeat(300),
          photo: 'https://ai-traffic-pro.ru/blog/test.jpg',
        },
        PREVIEW_AUTH,
      ),
      env,
    );
    data = await res.json();
  } finally {
    tg.restore();
  }

  assert.equal(res.status, 400);
  assert.match(data.error, /1024/);
  assert.match(data.error, /сократите/);
  assert.equal(tg.calls.length, 0);
});

test('callback: черновик с картинкой публикуется в канал как фото', async () => {
  const env = previewEnv();
  const link = 'https://ai-traffic-pro.ru/blog/test/?utm_source=telegram';
  await env.LEADS.put(
    'draft:tg:test',
    JSON.stringify({ html: '<b>Пост</b>', linkUrl: link, photo: 'https://ai-traffic-pro.ru/blog/test.jpg' }),
  );

  const tg = captureCalls();
  try {
    await call(
      '/api/tg/webhook/',
      {
        method: 'POST',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret' },
        body: JSON.stringify({
          update_id: 20,
          callback_query: {
            id: 'q2',
            data: 'tgpub:test',
            message: { message_id: 7, chat: { id: '123' } },
          },
        }),
      },
      env,
    );
  } finally {
    tg.restore();
  }

  const posted = tg.calls.find((c) => c.method === 'sendPhoto' && c.body.chat_id === '@aitrafficpro');
  assert.ok(posted, 'в канал уходит фото, а не текст');
  assert.equal(posted.body.photo, 'https://ai-traffic-pro.ru/blog/test.jpg');
  assert.match(posted.body.caption, /<b>Пост<\/b>/);
  assert.equal(posted.body.reply_markup.inline_keyboard[0][0].url, link);

  // Подтверждение владельцу правит подпись, а не текст: иначе Telegram
  // отклонит правку фото-сообщения и кнопки останутся живыми.
  assert.ok(tg.calls.some((c) => c.method === 'editMessageCaption'));
  assert.equal(tg.calls.some((c) => c.method === 'editMessageText'), false);

  assert.equal(env.LEADS.store.get('draft:tg:test'), undefined, 'черновик удалён');
  assert.ok(JSON.parse(env.LEADS.store.get('pub:last')).message_id, 'след публикации записан');
});

/* ──────────────────────────────────────────────────────────────────────────
 * Правка медиа в опубликованном посте (POST /api/tg/media)
 *
 * Обложка переделывается чаще, чем выходит пост. Правим картинку и подпись
 * по message_id из `pub:last`, чтобы не публиковать статью второй раз.
 * ────────────────────────────────────────────────────────────────────────── */

/** Кладёт в KV след последней публикации — от него зависит правка. */
async function seedPublished(env, slug = 'test', messageId = 5) {
  await env.LEADS.put(
    'pub:last',
    JSON.stringify({
      slug,
      content: '',
      message_id: messageId,
      link: `https://ai-traffic-pro.ru/blog/${slug}/?utm_source=telegram`,
      ts: '2026-11-16T11:19:16.993Z',
    }),
  );
}

test('media: заменяет фото и подпись, место в ленте сохраняется', async () => {
  const env = previewEnv();
  await seedPublished(env);
  const tg = captureCalls();
  let data;
  try {
    const res = await call(
      '/api/tg/media',
      post(
        {
          slug: 'test',
          text: 'Окупаемость рекламы считают до запуска, а не после.',
          photo: 'https://ai-traffic-pro.ru/blog/test.jpg',
        },
        PREVIEW_AUTH,
      ),
      env,
    );
    data = await res.json();
  } finally {
    tg.restore();
  }

  assert.equal(data.ok, true);
  assert.equal(data.message_id, 5);

  const edit = tg.calls.find((c) => c.method === 'editMessageMedia');
  assert.ok(edit, 'правка идёт через editMessageMedia');
  assert.equal(edit.body.message_id, 5, 'тот же пост, а не новый');
  assert.equal(edit.body.chat_id, '@aitrafficpro');
  assert.equal(edit.body.media.type, 'photo');
  assert.equal(edit.body.media.media, 'https://ai-traffic-pro.ru/blog/test.jpg');
  assert.match(edit.body.media.caption, /Окупаемость рекламы/);
  assert.equal(edit.body.media.parse_mode, 'HTML');
  assert.match(edit.body.reply_markup.inline_keyboard[0][0].url, /utm_source=telegram/);

  const last = JSON.parse(await env.LEADS.get('pub:last'));
  assert.equal(last.photo, 'https://ai-traffic-pro.ru/blog/test.jpg');
  assert.equal(last.message_id, 5, 'message_id не меняется после правки');
});

test('media: чужой слаг — 409, канал не трогаем', async () => {
  const env = previewEnv();
  await seedPublished(env, 'drugaya-statya');
  const tg = captureCalls();
  let res;
  let data;
  try {
    res = await call(
      '/api/tg/media',
      post(
        { slug: 'test', text: 'Текст', photo: 'https://ai-traffic-pro.ru/blog/test.jpg' },
        PREVIEW_AUTH,
      ),
      env,
    );
    data = await res.json();
  } finally {
    tg.restore();
  }

  assert.equal(res.status, 409);
  assert.match(data.error, /drugaya-statya/);
  assert.equal(tg.calls.length, 0);
});

test('media: без публикации править нечего — 409', async () => {
  const env = previewEnv();
  const res = await call(
    '/api/tg/media',
    post(
      { slug: 'test', text: 'Текст', photo: 'https://ai-traffic-pro.ru/blog/test.jpg' },
      PREVIEW_AUTH,
    ),
    env,
  );
  assert.equal(res.status, 409);
});

test('media: без токена — 401, с плохим адресом картинки — 400', async () => {
  const env = previewEnv();
  await seedPublished(env);

  const noAuth = await call(
    '/api/tg/media',
    post({ slug: 'test', text: 'Текст', photo: 'https://ai-traffic-pro.ru/blog/test.jpg' }),
    env,
  );
  assert.equal(noAuth.status, 401);

  const badPhoto = await call(
    '/api/tg/media',
    post({ slug: 'test', text: 'Текст', photo: 'javascript:alert(1)' }, PREVIEW_AUTH),
    env,
  );
  assert.equal(badPhoto.status, 400);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Диалог виджета: история и ранний переход к контакту
 *
 * Тестовый диалог 16.11.2026: на «я имею в виду создание лендинга» бот выдал
 * общий список услуг, а потом интервью из четырёх пунктов. Причина — виджет
 * не присылал историю, а намерение «нужен лендинг» не считалось горячим.
 * ────────────────────────────────────────────────────────────────────────── */

test('chat: история диалога доходит до модели', async () => {
  const captured = [];
  const env = makeEnv();
  env.AI = {
    async run(model, options) {
      captured.push(options.messages);
      return { response: 'Ок' };
    },
  };

  await call(
    '/api/chat',
    post({
      // Без ключевых слов базы знаний — иначе ответ придёт без модели.
      message: 'И что дальше?',
      messages: [
        { role: 'user', text: 'В какие сроки вы делаете лендинг?' },
        { role: 'bot', text: 'Лендинг — от 1,5–2 недель.' },
      ],
    }),
    env,
  );

  const messages = captured[0];
  assert.equal(messages.at(-1).content, 'И что дальше?', 'текущий вопрос последний');
  assert.ok(
    messages.some((m) => m.role === 'assistant' && /1,5–2 недель/.test(m.content)),
    'прошлый ответ бота попал в контекст как assistant',
  );
  assert.ok(
    messages.some((m) => m.role === 'user' && /сроки/.test(m.content)),
    'и прошлый вопрос человека тоже',
  );
});

test('chat: «нужен лендинг» — контакт просят сразу, без слов о цене', async () => {
  const env = makeEnv({ token: 'test-token' });
  let body;
  try {
    const res = await call('/api/chat', post({ message: 'Нужен лендинг под ключ' }), env);
    body = await res.json();
  } finally {
    /* Telegram здесь не нужен: проверяем сигнал виджету. */
  }

  assert.equal(body.askContact, true, 'намерение заказать — это уже заявка');
});

test('chat: «что для этого требуется» — тоже момент для контакта', async () => {
  const env = makeEnv();
  const res = await call('/api/chat', post({ message: 'А что для этого требуется от меня?' }), env);
  const body = await res.json();
  assert.equal(body.askContact, true, 'человек примеряет работу на себя — берём контакт');
});

test('chat: «как выбрать канал» — обычный вопрос, контакт не просят', async () => {
  const env = makeEnv();
  const res = await call('/api/chat', post({ message: 'Как выбрать канал продвижения?' }), env);
  const body = await res.json();
  assert.equal(body.askContact, false);
});

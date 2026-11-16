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
  await call('/api/tg/webhook/', tgPost(tgMessage('/start@ai_bureau_new_bot ai_traffic_pro')), env);
  assert.equal(JSON.parse(env.LEADS.store.get('ref:555')).label, 'ai_traffic_pro');
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
  assert.deepEqual(data.sources, [
    { label: 'ai_traffic_pro', count: 2 },
    { label: 'direct', count: 1 },
    { label: 'yandex_direct', count: 1 },
  ]);
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

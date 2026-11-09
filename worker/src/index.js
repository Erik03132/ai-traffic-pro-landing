/**
 * AI-Traffic PRO — Cloudflare Worker (API без VPS).
 *
 * Заменяет `server/server.js` на VPS: принимает заявки в Telegram и отвечает
 * виджету. Статика при этом остаётся на GitHub Pages — Worker обслуживает
 * только `/api/*` на поддомене `api.ai-traffic-pro.ru`.
 *
 * Отличия от VPS-варианта (сознательные):
 *   - LLM — Workers AI внутри CF. Внешние провайдеры из РФ отдают 403
 *     (Cloudflare блокирует запросы с российских IP), а Worker ходит из CF-эджа.
 *   - Бэкап лидов — Workers KV вместо JSONL-файла на диске.
 *   - Rate limit — встроенный binding (приблизительный, по локациям).
 *   - Секреты — `wrangler secret put`, не `.env` на сервере.
 *
 * Общая логика (база знаний, валидация) — в `../../server/agent-core.js`:
 * один источник истины для обоих рантаймов.
 */
import {
  EMPTY_REPLY,
  FALLBACK_REPLY,
  buildLlmMessages,
  findKnowledge,
  formatLeadMessage,
  validateLead,
} from '../../server/agent-core.js';
import {
  buildLink,
  channelKeyboard,
  draftKeyboard,
  draftKey,
  isSlug,
  parseCallback,
  renderPost,
} from './publish.js';

/* ──────────────────────────────────────────────────────────────────────────
 * Конфигурация
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Разрешённые origin. Пустой `*` не используем: иначе любой сторонний сайт
 * сможет слать заявки от имени нашего домена.
 * Задаётся переменной окружения `ALLOWED_ORIGINS` (через запятую).
 */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * CORS-заголовки для разрешённого origin.
 * @param {Request} request
 * @param {Record<string, string>} env
 */
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = allowedOrigins(env);
  if (!origin || !allowed.includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

/** JSON-ответ с CORS-заголовками. */
function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });
}

/**
 * Реальный IP клиента. В Worker это `CF-Connecting-IP` — его подделать
 * клиент не может, Cloudflare перезаписывает заголовок.
 */
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/* ──────────────────────────────────────────────────────────────────────────
 * Telegram
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Отправка заявки в Telegram.
 *
 * Заявка не должна теряться: сначала пишем в KV, потом шлём в Telegram.
 * Если Telegram недоступен — заявка уже в KV, отвечаем 200.
 *
 * @param {Record<string, string>} lead
 * @param {Record<string, unknown>} env
 * @param {KVNamespace | undefined} kv
 */
async function deliverLead(lead, env, kv) {
  const receivedAt = new Date().toISOString();
  const record = { ...lead, receivedAt };

  // 1. Бэкап в KV — источник правды для ручной обработки.
  if (kv) {
    try {
      const day = receivedAt.slice(0, 10);
      // Ключ по секунде: несколько заявок в одну секунду не затирают друг друга.
      const key = `lead:${day}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
      await kv.put(key, JSON.stringify(record), { expirationTtl: 60 * 60 * 24 * 90 });
    } catch (e) {
      console.error('❌ Не удалось сохранить лид в KV:', e.message);
    }
  }

  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('⚠️  Telegram не настроен — лид сохранён в KV');
    return true;
  }

  const text =
    `${formatLeadMessage(record)}\n\n🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error('❌ Telegram API отклонил сообщение:', data.description);
      return true; // Заявка в KV — не потеряна.
    }
    console.log('✅ Заявка отправлена в Telegram');
    return true;
  } catch (e) {
    console.error('❌ Ошибка отправки заявки в Telegram:', e.message);
    return true; // Заявка в KV — не потеряна.
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * LLM: Workers AI
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Модель Workers AI.
 *
 * `deepseek-v4-*` требуют Workers Paid ($5/мес), поэтому берём бесплатную
 * `llama-3.1-8b-instruct-fp8-fast` — 8 млрд параметров, русский понимает.
 */
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

/**
 * Вызов Workers AI.
 *
 * @param {{role: string, content: string}[]} messages
 * @param {Record<string, unknown>} env
 * @returns {Promise<string>}
 */
async function callAi(messages, env) {
  const resp = await env.AI.run(AI_MODEL, {
    messages,
    max_tokens: 400,
    temperature: 0.3,
  });

  const content = resp?.response;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Workers AI вернул пустой ответ');
  }
  return content.trim();
}

/* ──────────────────────────────────────────────────────────────────────────
 * Публикация постов в канал с подтверждением
 * ────────────────────────────────────────────────────────────────────────── */

/** Сколько живёт черновик до нажатия кнопки. */
const DRAFT_TTL = 60 * 60 * 24 * 14;

/**
 * Вызов метода Bot API. Ошибки возвращаются объектом, а не бросаются:
 * сеть до Telegram может отвалиться, а заявку всё равно нужно обработать.
 * @returns {Promise<{ok: boolean, result?: unknown, description?: string}>}
 */
async function tgCall(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, description: 'TELEGRAM_BOT_TOKEN не задан' };
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

/** Эндпоинты черновиков закрыты токеном: иначе кто угодно постит в канал. */
function publishAuthorized(request, env) {
  if (!env.TG_PUBLISH_TOKEN) return false;
  return request.headers.get('Authorization') === `Bearer ${env.TG_PUBLISH_TOKEN}`;
}

/**
 * POST /api/tg/preview — отправить черновик владельцу канала.
 * Тело: `{ slug, text, content? }`. В `text` ссылка пишется как
 * `[фраза]({{link}})` — адрес с UTM подставит Worker.
 */
async function handleTgPreview(request, env, kv) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }
  if (!env.TELEGRAM_CHAT_ID) {
    return json({ error: 'TELEGRAM_CHAT_ID не задан' }, request, env, 500);
  }

  const payload = await request.json().catch(() => ({}));
  const slug = String(payload.slug || '');

  if (!isSlug(slug)) return json({ error: 'плохой слаг' }, request, env, 400);

  const content = String(payload.content || '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 40);
  const linkUrl = buildLink(slug, content, env.SITE_URL);

  let html;
  try {
    html = renderPost(payload.text, linkUrl);
  } catch (e) {
    return json({ error: e.message }, request, env, 400);
  }

  // Черновик в KV: по кнопке публикуем ровно тот текст, который видел человек.
  if (kv) {
    await kv.put(draftKey(slug, content), JSON.stringify({ html, linkUrl }), {
      expirationTtl: DRAFT_TTL,
    });
  }

  const sent = await tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: `${html}\n\n<i>Черновик поста. Проверьте текст и нажмите кнопку.</i>`,
    parse_mode: 'HTML',
    reply_markup: draftKeyboard(slug, content),
  });

  if (!sent.ok) {
    return json({ error: sent.description || 'telegram error' }, request, env, 502);
  }

  return json({ ok: true, slug, link: linkUrl }, request, env);
}

/**
 * POST /api/tg/webhook — нажатия кнопок под черновиком.
 *
 * Публикация только по кнопке «Опубликовать»: бот не постит сам. Текст берём
 * из KV, а не из сообщения, — так подпись не подделать правкой чата.
 */
async function handleTgWebhook(request, env, kv) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';

  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }

  const update = await request.json().catch(() => ({}));
  const query = update.callback_query;

  // Прочие апдейты (сообщения боту) нас не касаются.
  if (!query) return json({ ok: true }, request, env);

  const message = query.message || {};
  const chatId = String((message.chat || {}).id ?? '');

  // Кнопки работают только в личном чате владельца: чужое нажатие игнорируем.
  if (String(env.TELEGRAM_CHAT_ID) !== chatId) {
    return json({ ok: true }, request, env);
  }

  const { action, slug, content } = parseCallback(query.data);

  if (action === 'unknown') {
    await tgCall(env, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Кнопка устарела',
    });
    return json({ ok: true }, request, env);
  }

  const key = draftKey(slug, content);
  const raw = kv ? await kv.get(key) : null;
  const draft = raw ? JSON.parse(raw) : null;

  if (!draft) {
    await tgCall(env, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Черновик устарел — отправьте пост заново',
    });
    return json({ ok: true }, request, env);
  }

  if (action === 'tgdrop') {
    if (kv) await kv.delete(key);
    await tgCall(env, 'editMessageText', {
      chat_id: chatId,
      message_id: message.message_id,
      text: `${draft.html}\n\n<i>❌ Отклонено — в канал не ушло</i>`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
    await tgCall(env, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Отклонено',
    });
    return json({ ok: true }, request, env);
  }

  if (!env.TELEGRAM_CHANNEL_ID) {
    await tgCall(env, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Канал не настроен',
    });
    return json({ error: 'TELEGRAM_CHANNEL_ID не задан' }, request, env, 500);
  }

  const posted = await tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_CHANNEL_ID,
    text: draft.html,
    parse_mode: 'HTML',
    reply_markup: channelKeyboard(draft.linkUrl),
  });

  if (!posted.ok) {
    // Причина важна: обычно это «bot is not a member of the channel» или
    // «not enough rights» — то есть бота не добавили админом.
    await tgCall(env, 'answerCallbackQuery', {
      callback_query_id: query.id,
      text: `Не вышло: ${posted.description || 'ошибка Telegram'}`,
    });
    return json({ error: posted.description }, request, env, 502);
  }

  if (kv) await kv.delete(key);
  await tgCall(env, 'editMessageText', {
    chat_id: chatId,
    message_id: message.message_id,
    text: `${draft.html}\n\n<i>✅ Опубликовано в канале</i>`,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
  await tgCall(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: 'Опубликовано',
  });

  return json({ ok: true }, request, env);
}

/**
 * POST /api/tg/init — регистрирует вебхук для кнопок.
 * Вызывается один раз после деплоя: URL и секрет знает Worker, не человек.
 */
async function handleTgInit(request, env) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: 'TELEGRAM_WEBHOOK_SECRET не задан' }, request, env, 500);
  }

  const hook = new URL('/api/tg/webhook', request.url).toString();
  const hookRes = await tgCall(env, 'setWebhook', {
    url: hook,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['callback_query'],
  });
  const meRes = await tgCall(env, 'getMe');
  const botId = meRes.result?.id;

  // Права в канале проверяем сразу: без «Публикация сообщений» кнопка
  // «Опубликовать» будет падать, и лучше узнать это до первого поста.
  let channel = null;
  if (env.TELEGRAM_CHANNEL_ID) {
    const chatRes = await tgCall(env, 'getChat', { chat_id: env.TELEGRAM_CHANNEL_ID });
    const memberRes = botId
      ? await tgCall(env, 'getChatMember', {
          chat_id: env.TELEGRAM_CHANNEL_ID,
          user_id: botId,
        })
      : { ok: false, description: 'бот не определён' };

    channel = {
      title: chatRes.result?.title ?? null,
      chat_error: chatRes.ok ? null : chatRes.description,
      status: memberRes.result?.status ?? null,
      can_post_messages: Boolean(memberRes.result?.can_post_messages),
      rights_error: memberRes.ok ? null : memberRes.description,
    };
  }

  return json(
    { webhook: hookRes, bot: meRes.result?.username ?? null, channel },
    request,
    env,
    hookRes.ok ? 200 : 502,
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Обработчики
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/lead — заявка с формы.
 */
async function handleLead(request, env, kv) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, errors: ['body'] }, request, env, 400);
  }

  const validation = validateLead(payload);

  if (validation.honeypot) {
    // Бот: отвечаем «успех», но заявку никуда не отправляем.
    return json({ ok: true }, request, env);
  }

  if (!validation.ok) {
    return json({ ok: false, errors: validation.errors }, request, env, 400);
  }

  const sent = await deliverLead(validation.lead, env, kv);
  return json({ ok: sent }, request, env, sent ? 200 : 502);
}

/**
 * POST /api/chat — вопрос из виджета.
 */
async function handleChat(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad request' }, request, env, 400);
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return json({ error: 'empty message' }, request, env, 400);
  }

  // 1. База знаний — дешёвый и точный путь.
  const known = findKnowledge(message);
  if (known) {
    return json({ reply: known, source: 'knowledge' }, request, env);
  }

  // 2. Workers AI — если база не помогла.
  const history = Array.isArray(payload.messages) ? payload.messages.slice(-8) : [];
  const llmMessages = buildLlmMessages(history, message);

  let reply = '';
  let source = 'llm';
  try {
    reply = await callAi(llmMessages, env);
  } catch (e) {
    console.error('❌ Workers AI недоступен:', e.message);
    source = 'fallback';
    reply = FALLBACK_REPLY;
  }

  if (!reply) {
    source = 'fallback';
    reply = EMPTY_REPLY;
  }

  return json({ reply, source }, request, env);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Вход
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @param {Request} request
 * @param {Record<string, unknown>} env
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Astro добавляет trailing slash (`trailingSlash: 'always'`), приводим к
    // единому виду — иначе /api/chat/ не найдёт эндпоинт.
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === 'GET' && pathname === '/api/health') {
      return json(
        {
          ok: true,
          telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
          ai: Boolean(env.AI),
          publish: Boolean(env.TG_PUBLISH_TOKEN && env.TELEGRAM_CHANNEL_ID),
        },
        request,
        env,
      );
    }

    if (request.method === 'POST' && pathname === '/api/tg/preview') {
      return await handleTgPreview(request, env, env.LEADS);
    }

    if (request.method === 'POST' && pathname === '/api/tg/webhook') {
      return await handleTgWebhook(request, env, env.LEADS);
    }

    if (request.method === 'POST' && pathname === '/api/tg/init') {
      return await handleTgInit(request, env);
    }

    if (request.method !== 'POST' || (pathname !== '/api/chat' && pathname !== '/api/lead')) {
      return json({ error: 'not found' }, request, env, 404);
    }

    // Rate limit: отдельные баки для виджета и формы (как на VPS) —
    // 10 сообщений в чате не должны блокировать отправку заявок.
    const bucket = pathname === '/api/chat' ? 'chat' : 'lead';
    const limiter = bucket === 'chat' ? env.CHAT_LIMITER : env.LEAD_LIMITER;
    if (limiter) {
      const { success } = await limiter.limit({ key: `${bucket}:${clientIp(request)}` });
      if (!success) {
        return json(
          {
            error: 'rate limit',
            reply: 'Слишком много запросов. Подождите минуту.',
          },
          request,
          env,
          429,
        );
      }
    }

    try {
      if (pathname === '/api/lead') {
        return await handleLead(request, env, env.LEADS);
      }
      return await handleChat(request, env);
    } catch (e) {
      console.error('❌ Ошибка сервера:', e.message);
      return json({ error: 'server error' }, request, env, 500);
    }
  },
};

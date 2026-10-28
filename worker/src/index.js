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
        },
        request,
        env,
      );
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

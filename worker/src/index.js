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
  CAPTION_LIMIT,
  buildLink,
  channelKeyboard,
  draftKeyboard,
  draftKey,
  draftSentKey,
  duePublications,
  isPhotoUrl,
  isSlug,
  manifestUrl,
  parseCallback,
  publicationId,
  publishedKey,
  renderPost,
  todayMsk,
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
 * Собирает и отправляет черновик владельцу канала.
 *
 * Одна функция на два входа — ручную отправку (`POST /api/tg/preview`) и cron
 * (этап 2, ADR-005). Разнести их значит получить два разных вида поста: в
 * ручном и в автоматическом текст начнёт расходиться — то лимиты, то
 * клавиатура, то подстановка ссылки.
 *
 * @returns {Promise<{ok: boolean, status: number, error?: string, link?: string}>}
 */
async function deliverDraft(env, kv, { slug, content = '', text, photo = '' }) {
  const linkUrl = buildLink(slug, content, env.SITE_URL);

  let html;
  try {
    html = renderPost(text, linkUrl);
  } catch (e) {
    return { ok: false, status: 400, error: e.message };
  }

  // Картинка — необязательная часть поста. В канале она поднимает заметность,
  // но и без неё пост выходит: фото не должно быть условием публикации.
  if (photo && !isPhotoUrl(photo)) {
    return { ok: false, status: 400, error: 'плохой адрес картинки' };
  }

  const preview = `${html}\n\n<i>Черновик поста. Проверьте текст и нажмите кнопку.</i>`;
  if (photo && preview.length > CAPTION_LIMIT) {
    return {
      ok: false,
      status: 400,
      error:
        `для поста с картинкой текст ограничен ${CAPTION_LIMIT} знаками, ` +
        `сейчас ${preview.length} — сократите`,
    };
  }

  // Черновик в KV: по кнопке публикуем ровно тот текст, который видел человек.
  if (kv) {
    await kv.put(draftKey(slug, content), JSON.stringify({ html, linkUrl, photo }), {
      expirationTtl: DRAFT_TTL,
    });
  }

  const sent = await tgCall(env, photo ? 'sendPhoto' : 'sendMessage', {
    chat_id: env.TELEGRAM_CHAT_ID,
    ...(photo
      ? { photo, caption: preview }
      : { text: preview }),
    parse_mode: 'HTML',
    reply_markup: draftKeyboard(slug, content),
  });

  if (!sent.ok) {
    return { ok: false, status: 502, error: sent.description || 'telegram error' };
  }

  return { ok: true, status: 200, link: linkUrl };
}

/**
 * POST /api/tg/preview — отправить черновик владельцу канала.
 * Тело: `{ slug, text, content?, photo? }`. В `text` ссылка пишется как
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

  const result = await deliverDraft(env, kv, {
    slug,
    content,
    text: payload.text,
    photo: String(payload.photo || ''),
  });

  if (!result.ok) return json({ error: result.error }, request, env, result.status);

  return json({ ok: true, slug, link: result.link }, request, env);
}

/**
 * Cron: черновик ближайшей публикации, у которой наступила дата (этап 2).
 *
 * Очередь приходит манифестом с сайта (`/dist/manifest.json`), а не из KV:
 * тексты постов живут в git, и копия в KV разошлась бы с оригиналом молча.
 * Порядок и условия отбора — в `duePublications`.
 *
 * Идемпотентность двойная: `pub:tg:<id>` — пост уже вышел, `sent:tg:<id>` —
 * черновик уже отправлен. Без второй метки cron присылал бы один и тот же
 * черновик каждое утро, пока его не опубликуют.
 */
async function prepareDueDraft(env, kv, { force = false } = {}) {
  if (!env.TELEGRAM_CHAT_ID || !kv) return { ok: false, reason: 'не настроено' };

  let manifest;
  try {
    const resp = await fetch(manifestUrl(env.SITE_URL));
    if (!resp.ok) return { ok: false, reason: `манифест ${resp.status}` };
    manifest = await resp.json();
  } catch (e) {
    return { ok: false, reason: `манифест недоступен: ${e.message}` };
  }

  // `force` — это «отправить ближайший пост сейчас, не ждать даты»: нужно для
  // проверки после деплоя и для случая «владелец хочет выйти сегодня».
  const queue = duePublications(manifest.publications, force ? '9999-12-31' : todayMsk());

  for (const pub of queue) {
    if (await kv.get(publishedKey(pub.id))) continue;
    if (await kv.get(draftSentKey(pub.id))) {
      return { ok: true, skipped: 'черновик уже отправлен', id: pub.id };
    }

    const result = await deliverDraft(env, kv, {
      slug: pub.slug,
      content: pub.post,
      text: pub.text,
      photo: pub.photo || '',
    });

    if (!result.ok) {
      console.error(`dist: черновик ${pub.id} не ушёл: ${result.error}`);
      return { ok: false, id: pub.id, reason: result.error };
    }

    await kv.put(draftSentKey(pub.id), new Date().toISOString(), {
      expirationTtl: 60 * 60 * 24 * 3,
    });
    return { ok: true, id: pub.id };
  }

  return { ok: true, skipped: queue.length ? 'все уже отправлены' : 'очередь пуста' };
}

/**
 * POST /api/dist/run — прогнать очередь вручную.
 *
 * Нужен, чтобы не ждать утренний cron: проверить настройку сразу после деплоя,
 * дослать черновик после сбоя. Закрыт тем же токеном, что и отправка:
 * иначе любой желающий дёргает бота и получает черновики в личку владельца.
 */
async function handleDistRun(request, env, kv) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }
  // `?force=1` — взять ближайшую запись, не глядя на дату.
  const force = new URL(request.url).searchParams.get('force') === '1';
  const result = await prepareDueDraft(env, kv, { force });
  return json(result, request, env, result.ok ? 200 : 502);
}

/**
 * POST /api/tg/media — заменить картинку и подпись в уже опубликованном посте.
 * Тело: `{ slug, text, photo }`. `message_id` берётся из `pub:last`, а не из
 * запроса: правим только тот пост, который сами опубликовали, — иначе эндпоинт
 * с токеном превращается в «отредактируй любой пост канала».
 *
 * Зачем: обложка статьи переделывается чаще, чем выходит пост. Правка медиа
 * сохраняет `message_id` и место в ленте, дубля в канале не появляется.
 */
async function handleTgMedia(request, env, kv) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }
  if (!env.TELEGRAM_CHANNEL_ID) {
    return json({ error: 'TELEGRAM_CHANNEL_ID не задан' }, request, env, 500);
  }

  const payload = await request.json().catch(() => ({}));
  const slug = String(payload.slug || '');
  if (!isSlug(slug)) return json({ error: 'плохой слаг' }, request, env, 400);

  const photo = String(payload.photo || '');
  if (!isPhotoUrl(photo)) {
    return json({ error: 'плохой адрес картинки' }, request, env, 400);
  }

  const raw = kv ? await kv.get('pub:last') : null;
  const last = raw ? JSON.parse(raw) : null;
  if (!last || !last.message_id) {
    return json({ error: 'ещё ничего не публиковалось' }, request, env, 409);
  }
  if (last.slug !== slug) {
    return json(
      { error: `последний пост в канале — «${last.slug}», а не «${slug}»` },
      request,
      env,
      409,
    );
  }

  // Ссылку собираем тем же способом, что при публикации: UTM-метки не должны
  // разъехаться между постом и подписью, иначе статистика начнёт врать.
  const linkUrl = buildLink(slug, String(last.content || ''), env.SITE_URL);

  let html;
  try {
    html = renderPost(payload.text, linkUrl);
  } catch (e) {
    return json({ error: e.message }, request, env, 400);
  }
  if (html.length > CAPTION_LIMIT) {
    return json(
      { error: `подпись к фото ограничена ${CAPTION_LIMIT} знаками, сейчас ${html.length}` },
      request,
      env,
      400,
    );
  }

  const edited = await tgCall(env, 'editMessageMedia', {
    chat_id: env.TELEGRAM_CHANNEL_ID,
    message_id: last.message_id,
    media: { type: 'photo', media: photo, caption: html, parse_mode: 'HTML' },
    reply_markup: channelKeyboard(linkUrl),
  });

  if (!edited.ok) {
    return json({ error: edited.description || 'telegram error' }, request, env, 502);
  }

  if (kv) {
    await kv.put(
      'pub:last',
      JSON.stringify({
        ...last,
        photo,
        link: linkUrl,
        media_ts: new Date().toISOString(),
      }),
      { expirationTtl: 60 * 60 * 24 * 90 },
    );
  }

  return json({ ok: true, slug, message_id: last.message_id, photo }, request, env);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Атрибуция входа: `t.me/<бот>?start=<метка>`
 *
 * Telegram отдаёт метку в `message.text` как `/start <метка>`. Запоминаем
 * только ПЕРВЫЙ источник пользователя: иначе повторный заход из рекламы
 * затрёт органику и отчёт начнёт врать.
 * ────────────────────────────────────────────────────────────────────────── */

/** Префикс ключа KV: одна запись на пользователя. */
const REF_PREFIX = 'ref:';

/** Telegram ограничивает payload диплинка 64 символами. */
const REF_LABEL_MAX = 64;

/**
 * Разбор `/start` и `/start <метка>`.
 * @param {string} text текст сообщения
 * @returns {{label: string} | null} `null`, если это не команда старта
 */
function parseStart(text) {
  const match = /^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?/.exec(String(text || '').trim());
  if (!match) return null;
  return { label: (match[1] || '').slice(0, REF_LABEL_MAX) };
}

/**
 * Клавиатура первого ответа. Только ссылки: цен и обещаний в боте нет.
 * @param {string} siteUrl база сайта
 */
function startKeyboard(siteUrl) {
  const base = String(siteUrl || 'https://ai-traffic-pro.ru').replace(/\/+$/, '');
  return {
    inline_keyboard: [
      [
        { text: 'Сайт', url: `${base}/` },
        { text: 'Оставить заявку', url: `${base}/#lead` },
      ],
    ],
  };
}

/**
 * Запоминает первый источник пользователя и уведомляет владельца.
 * @param {Record<string, unknown>} env
 * @param {KVNamespace | undefined} kv
 * @param {{id: number, username?: string, first_name?: string, last_name?: string}} from
 * @param {string} label метка из диплинка (пустая = прямой заход)
 */
async function rememberRef(env, kv, from, label) {
  const key = `${REF_PREFIX}${from.id}`;
  const seen = kv ? await kv.get(key) : null;

  const record = {
    label: label || 'direct',
    user_id: from.id,
    username: from.username || null,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
    ts: new Date().toISOString(),
  };

  if (!seen && kv) await kv.put(key, JSON.stringify(record));

  // Первый источник не перезаписываем, но последнее касание фиксируем:
  // по нему видно, какая кампания вернула человека обратно.
  if (seen && kv && label) {
    try {
      const prev = JSON.parse(seen);
      if (label !== prev.label) {
        await kv.put(
          key,
          JSON.stringify({ ...prev, last_label: label, last_ts: record.ts }),
        );
      }
    } catch {
      // Битая запись не повод терять вход: приветствие важнее.
    }
  }

  const owner = String(env.TELEGRAM_CHAT_ID || '');
  if (owner) {
    await tgCall(env, 'sendMessage', {
      chat_id: owner,
      text:
        `Вход в бота: ${record.label}${seen ? ' (повторный)' : ''}\n` +
        `${record.name || 'без имени'} @${record.username || '—'} id ${record.user_id}`,
      disable_web_page_preview: true,
    });
  }

  return { first: !seen, record };
}

/**
 * Сообщения боту: `/start` с меткой и вопросы клиента.
 *
 * Бот не консультант — он не отвечает по существу. Вопрос пересылается
 * владельцу, клиенту уходит подтверждение: молчание дороже плохого ответа.
 */
async function handleTgMessage(env, kv, msg) {
  const chat = msg.chat || {};
  const from = msg.from || {};

  // В группах и каналах не работаем: там метка не наша, а шум общий.
  if (chat.type !== 'private' || from.is_bot) return;

  const text = String(msg.text || '');
  const started = parseStart(text);

  if (started) {
    await rememberRef(env, kv, from, started.label);
    await tgCall(env, 'sendMessage', {
      chat_id: chat.id,
      text:
        'Здравствуйте! Это AI-Traffic PRO: трафик, реклама, сайты и аналитика.\n\n' +
        'Напишите вопрос одним сообщением — ответим здесь же.',
      reply_markup: startKeyboard(env.SITE_URL),
      disable_web_page_preview: true,
    });
    return;
  }

  if (!text.trim()) return;

  const owner = String(env.TELEGRAM_CHAT_ID || '');
  if (owner) {
    const who = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'без имени';
    await tgCall(env, 'sendMessage', {
      chat_id: owner,
      text:
        `Вопрос из бота от ${who} (@${from.username || 'без ника'}, id ${from.id}):\n\n` +
        text.slice(0, 3000),
      disable_web_page_preview: true,
    });
  }

  await tgCall(env, 'sendMessage', {
    chat_id: chat.id,
    text: 'Спасибо, вопрос получили. Ответим здесь же, в этом чате.',
  });
}

/**
 * GET /api/tg/sources — отчёт по источникам входа.
 *
 * Считаем по записям KV, а не счётчиком: инкремент в KV не атомарный, а
 * ошибка в счётчике не восстанавливается. Запись на пользователя — истина.
 *
 * Два среза: `sources` — первое касание (навсегда за человеком, не
 * перезаписывается), `lastTouch` — последнее (видно, какая кампания вернула
 * человека обратно). Без второго среза клиент, пришедший из закладки и потом
 * кликнувший рекламу, не засчитывается рекламе никогда.
 */
async function handleTgSources(request, env, kv) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }

  const firsts = new Map();
  const lasts = new Map();
  let cursor;
  let total = 0;
  let returning = 0;

  do {
    const page = kv
      ? await kv.list({ prefix: REF_PREFIX, cursor })
      : { keys: [], list_complete: true };
    for (const key of page.keys || []) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      const record = JSON.parse(raw);
      firsts.set(record.label, (firsts.get(record.label) || 0) + 1);
      total += 1;
      if (record.last_label) {
        lasts.set(record.last_label, (lasts.get(record.last_label) || 0) + 1);
        returning += 1;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json(
    { total, returning, sources: countList(firsts), lastTouch: countList(lasts) },
    request,
    env,
  );
}

/**
 * Map метка → количество в массив {label, count}.
 * При равном количестве — по алфавиту: отчёт должен быть воспроизводимым.
 * @param {Map<string, number>} counts
 */
function countList(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }));
}

/**
 * POST /api/tg/webhook — кнопки под черновиком и сообщения боту.
 *
 * Публикация только по кнопке «Опубликовать»: бот не постит сам. Текст берём
 * из KV, а не из сообщения, — так подпись не подделать правкой чата.
 */
/**
 * Правит сообщение с черновиком после нажатия кнопки.
 *
 * У поста с картинкой меняется подпись, а не текст: `editMessageText` на
 * фото-сообщении Telegram отклоняет, и кнопки остались бы висеть живыми.
 *
 * @param {Record<string, unknown>} env
 * @param {string} chatId
 * @param {number} messageId
 * @param {{html: string, photo?: string}} draft
 * @param {string} note пометка «опубликовано» / «отклонено»
 */
async function editDraftMessage(env, chatId, messageId, draft, note) {
  const text = `${draft.html}\n\n${note}`;
  const base = { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' };

  if (draft.photo) {
    // Подпись к фото ограничена 1024 знаками — в крайнем случае оставляем
    // только пометку, но факт нажатия не теряется.
    return tgCall(env, 'editMessageCaption', {
      ...base,
      caption: text.length > CAPTION_LIMIT ? note : text,
      reply_markup: { inline_keyboard: [] },
    });
  }

  return tgCall(env, 'editMessageText', {
    ...base,
    text,
    reply_markup: { inline_keyboard: [] },
  });
}

async function handleTgWebhook(request, env, kv) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';

  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }

  const update = await request.json().catch(() => ({}));

  // Наблюдаемость: без записи «бот молчит» не отличить от «апдейт не дошёл».
  // Держим один ключ-последний, а не ключ на каждый апдейт: читается одной
  // командой через GET /api/tg/last и не засоряет KV.
  if (kv) {
    try {
      const message = update.message || {};
      await kv.put(
        'dbg:last',
        JSON.stringify({
          ts: new Date().toISOString(),
          update_id: update.update_id ?? null,
          kind:
            Object.keys(update)
              .filter((k) => k !== 'update_id')
              .join(',') || 'пусто',
          chat: (message.chat || {}).type ?? null,
          from_id: (message.from || {}).id ?? null,
          text: String(message.text ?? '').slice(0, 120),
        }),
        { expirationTtl: 60 * 60 * 24 },
      );
    } catch (e) {
      console.error('dbg: не записался', e.message);
    }
  }

  if (update.message) {
    await handleTgMessage(env, kv, update.message);
    return json({ ok: true }, request, env);
  }

  const query = update.callback_query;

  // Прочие апдейты (правки сообщений, участники чата) нас не касаются.
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
    await editDraftMessage(env, chatId, message.message_id, draft, '<i>❌ Отклонено — в канал не ушло</i>');
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

  // Черновик мог быть создан с картинкой или без — публикуем тем же способом,
  // каким он пришёл владельцу: иначе фото потеряется при «Опубликовать».
  const photo = isPhotoUrl(draft.photo) ? draft.photo : '';
  const posted = await tgCall(env, photo ? 'sendPhoto' : 'sendMessage', {
    chat_id: env.TELEGRAM_CHANNEL_ID,
    ...(photo ? { photo, caption: draft.html } : { text: draft.html }),
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
  // След публикации: чтобы факт «пост ушёл» проверялся командой, а не глазами
  // владельца канала. message_id потом пригодится и для правок, и для удаления.
  if (kv) {
    try {
      await kv.put(
        'pub:last',
        JSON.stringify({
          slug,
          content: content ?? null,
          message_id: posted.result?.message_id ?? null,
          link: draft.linkUrl,
          ts: new Date().toISOString(),
        }),
      );
      // Метка для cron (этап 2, ADR-005): этот пост уже вышел, очередь его
      // больше не предлагает. Без неё реестр и манифест «забыли» бы факт
      // публикации до ручной правки registry.json.
      await kv.put(
        publishedKey(publicationId(slug, content ?? '')),
        JSON.stringify({
          message_id: posted.result?.message_id ?? null,
          link: draft.linkUrl,
          ts: new Date().toISOString(),
        }),
      );
    } catch (e) {
      console.error('pub:last: не записался', e.message);
    }
  }
  await editDraftMessage(env, chatId, message.message_id, draft, '<i>✅ Опубликовано в канале</i>');
  await tgCall(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: 'Опубликовано',
  });

  return json({ ok: true }, request, env);
}

/**
 * GET /api/tg/last — что произошло последним: публикация и последний апдейт.
 * Нужен, чтобы «пост ушёл?» проверялось командой, а не глазами в канале.
 */
async function handleTgLast(request, env, kv) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }

  const read = async (key) => {
    if (!kv) return null;
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  return json(
    { publish: await read('pub:last'), update: await read('dbg:last') },
    request,
    env,
  );
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
    allowed_updates: ['callback_query', 'message'],
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

/* ──────────────────────────────────────────────────────────────────────────
 * Лог вопросов из виджета
 *
 * Виджет отвечает сам и ничего не помнит. Без лога владелец не видит, о чём
 * спрашивают, — а «сколько стоит» в виджете это лид, который дошёл до диалога
 * и не дошёл до формы. Поэтому: вопрос пишем в KV с TTL, «горячий» — сразу
 * в Telegram. Вопросы пишем без ответов: KV на Free не резиновый, а
 * аналитическая ценность в формулировке клиента, не в пересказе модели.
 * ────────────────────────────────────────────────────────────────────────── */

/** Префикс ключа: `chat:q:<ISO>:<rand>` — сортируется по времени. */
const CHAT_LOG_PREFIX = 'chat:q:';

/** 30 дней хранения: дальше вопросы теряют ценность, а квота — нет. */
const CHAT_LOG_TTL = 60 * 60 * 24 * 30;

/** Потолок пушей в час: виджет публичный, спам не должен заливать чат. */
const HOT_LIMIT_PER_HOUR = 20;

/** Признаки «горячего» вопроса: цена, сроки, договор, заявка. */
const HOT_PATTERNS = [
  /цен[аыуе]|стоимост|сколько\s+стоит|прайс|бюджет/i,
  /срок|когда\s+(начн|запуст|старт)|за\s+сколько\s+дн/i,
  /договор|счёт|счет|оплат|предоплат|реквизит/i,
  /заявк|заказ|консультац|созвон|перезвон|коммерческ/i,
  // Намерение заказать: услугу уже назвали — контакт нужен сейчас, даже без
  // слов «цена» и «сроки». Иначе человек уходит на пятом уточняющем вопросе,
  // а заявки нет (тестовый диалог 16.11: «нужен лендинг» → интервью).
  /(нужен|нужна|нужно|хочу|хотим|интересует|планируем|требуется)\s+[^.!?]{0,40}(лендинг|сайт|магазин|реклам|продвижен|seo|смм|smm|воронк|crm|автоматизац)/i,
  /(заказать|разработать|сделать|запустить|настроить|вести|под\s+ключ)\s+[^.!?]{0,30}(лендинг|сайт|реклам|продвижен|магазин|воронк|crm|соцсет)/i,
  /(лендинг|сайт|магазин|воронка|crm)\s+(под\s+ключ|нужен|требуется)/i,
  // «Что от меня требуется», «как начать» — человек уже примеряет работу на
  // себя, это тот же момент, когда нужен контакт, а не ещё вопрос.
  /что\s+(для\s+этого\s+)?(требуется|нужно|надо)|как\s+начать|с\s+чего\s+начать|как\s+заказать/i,
];

/**
 * Считается ли вопрос «горячим».
 * @param {string} question
 * @returns {boolean}
 */
function isHotQuestion(question) {
  return HOT_PATTERNS.some((re) => re.test(question));
}

/**
 * Записывает вопрос и ответ в KV. Ошибка записи не должна ломать ответ клиенту.
 *
 * Ответ лежит в той же записи, а не отдельной: записей от этого не больше
 * (KV на Free считает именно записи), растёт только размер значения — 2-4 КБ
 * на вопрос. Без ответа лог отвечает на «о чём спрашивают», но не на «что
 * человек ушёл читать».
 *
 * @param {KVNamespace | undefined} kv
 * @param {{q: string, a?: string, source: string, page?: string}} record
 */
async function logChatQuestion(kv, record) {
  if (!kv) return;
  try {
    const ts = new Date().toISOString();
    const key = `${CHAT_LOG_PREFIX}${ts}:${crypto.randomUUID().slice(0, 8)}`;
    const entry = {
      ...record,
      q: record.q.slice(0, 500),
      // 1000 символов хватает: ответы длиннее — уже простыня, её не читают.
      a: typeof record.a === 'string' ? record.a.slice(0, 1000) : '',
      ts,
    };
    await kv.put(key, JSON.stringify(entry), { expirationTtl: CHAT_LOG_TTL });
  } catch (e) {
    console.error('❌ Не удалось записать вопрос виджета в KV:', e.message);
  }
}

/**
 * Пуш владельцу по «горячему» вопросу.
 *
 * Не чаще HOT_LIMIT_PER_HOUR в час: счётчик best-effort (инкремент в KV не
 * атомарный), задача — не залить чат спамом, а не точная бухгалтерия.
 *
 * @param {Record<string, unknown>} env
 * @param {KVNamespace | undefined} kv
 * @param {string} question
 * @param {string} source
 * @param {string} page страница сайта, с которой спросили
 */
async function notifyHotQuestion(env, kv, question, source, page) {
  const owner = String(env.TELEGRAM_CHAT_ID || '');
  if (!env.TELEGRAM_BOT_TOKEN || !owner) return;

  if (kv) {
    try {
      const key = `chat:hot:${new Date().toISOString().slice(0, 13)}`;
      const used = Number((await kv.get(key)) || 0);
      if (used >= HOT_LIMIT_PER_HOUR) return;
      await kv.put(key, String(used + 1), { expirationTtl: 60 * 60 * 2 });
    } catch {
      // Счётчик не сработал — лучше уведомить, чем промолчать.
    }
  }

  const answered = source === 'knowledge' ? 'база знаний' : source === 'llm' ? 'модель' : 'заглушка';
  await tgCall(env, 'sendMessage', {
    chat_id: owner,
    text:
      '🔥 Вопрос из виджета — похоже на клиента\n\n' +
      `${question.slice(0, 600)}\n\n` +
      `Страница: ${page || 'не передана'}\n` +
      `Ответил: ${answered}. Контакт виджет спросил сам — если человек его ` +
      'оставил, заявка придёт отдельным сообщением.',
    disable_web_page_preview: true,
  });
}

/**
 * POST /api/chat — вопрос из виджета.
 */
async function handleChat(request, env, kv, ctx) {
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

  // Контекст страницы виджет присылает с каждым вопросом. Без него в пуше не
  // понять, про какую услугу спросили, — а это половина смысла уведомления.
  const rawContext = payload.context && typeof payload.context === 'object' ? payload.context : {};
  const page = typeof rawContext.page === 'string' ? rawContext.page.slice(0, 200) : '';

  // Раз горячий вопрос — виджету есть смысл спросить контакт сразу.
  const hot = isHotQuestion(message);

  let reply = '';
  let source = 'llm';

  // 1. База знаний — дешёвый и точный путь.
  const known = findKnowledge(message);
  if (known) {
    reply = known;
    source = 'knowledge';
  } else {
    // 2. Workers AI — если база не помогла.
    const history = Array.isArray(payload.messages) ? payload.messages.slice(-8) : [];
    try {
      reply = await callAi(buildLlmMessages(history, message), env);
    } catch (e) {
      console.error('❌ Workers AI недоступен:', e.message);
      source = 'fallback';
      reply = FALLBACK_REPLY;
    }

    if (!reply) {
      source = 'fallback';
      reply = EMPTY_REPLY;
    }
  }

  // Лог и пуш — после ответа: клиент не должен ждать Telegram.
  // В проде есть ctx.waitUntil; в тестах его нет — ждём, чтобы видеть запись.
  const remember = async () => {
    await logChatQuestion(kv, { q: message, a: reply, source, page });
    if (hot) await notifyHotQuestion(env, kv, message, source, page);
  };
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(remember());
  else await remember();

  // `askContact` — сигнал виджету: спросить контакт пока человек здесь.
  return json({ reply, source, askContact: hot }, request, env);
}

/** Москва: сутки считаем по МСК, иначе «день» рвётся в 03:00 по местному. */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Человеческие названия источников ответа для текстового вида. */
const SOURCE_RU = { knowledge: 'база знаний', llm: 'модель', fallback: 'заглушка' };

/**
 * День по Москве для ISO-времени (`2026-11-16`).
 * @param {string} iso
 */
function mskDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  // Сдвигаем и берём дату из UTC-строки — так же, как считает `Date` в GET.
  const shifted = new Date(t + MSK_OFFSET_MS).toISOString();
  return shifted.slice(0, 10);
}

/**
 * Время по Москве, `ЧЧ:ММ`.
 * @param {string} iso
 */
function mskTime(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + MSK_OFFSET_MS).toISOString().slice(11, 16) : '--:--';
}

/**
 * Читаемый вид лога: один вопрос = время, страница, источник, «?» и «→».
 *
 * JSON удобен скриптам, но «что спрашивали и что отвечали» человек читает
 * глазами. Записи идут по времени вверх — так диалог читается как диалог.
 *
 * @param {Array<{q: string, a?: string, source?: string, page?: string, ts: string}>} records
 * @param {string} day день в формате `YYYY-MM-DD` или пусто
 */
function chatLogText(records, day) {
  const title = day
    ? `Вопросы из виджета за ${day.split('-').reverse().join('.')}`
    : 'Вопросы из виджета';

  if (!records.length) return `${title}: пусто.\n`;

  const blocks = records.map((r) => {
    const page = r.page || '—';
    const src = SOURCE_RU[r.source] || r.source || '—';
    // Старые записи (до 16.11.2026) ответа не содержат — честно говорим это,
    // а не показываем пустую строку.
    const answer = (r.a || '').trim() || '(ответ не сохранялся — запись старше 16.11.2026)';
    return `${mskTime(r.ts)}  ${page}  [${src}]\n  ? ${r.q}\n  → ${answer}`;
  });

  return `${title} — ${records.length}\n\n${blocks.join('\n\n')}\n`;
}

/**
 * GET /api/chat/log — вопросы из виджета (по токену).
 *
 * Ключи начинаются с ISO-времени, поэтому сортировка по имени = по времени.
 * Параметры:
 *   `limit=N`      сколько записей отдать (1..200; по умолчанию 50, для дня — 200);
 *   `day=YYYY-MM-DD` только этот день по Москве;
 *   `format=text`  читаемый диалог «вопрос → ответ» вместо JSON.
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {KVNamespace | undefined} kv
 */
async function handleChatLog(request, env, kv) {
  if (!publishAuthorized(request, env)) {
    return json({ error: 'unauthorized' }, request, env, 401);
  }

  const url = new URL(request.url);
  const wantText = url.searchParams.get('format') === 'text';
  const day = (url.searchParams.get('day') || '').trim();
  const asked = Number(url.searchParams.get('limit'));
  // За день читают целиком, а не первые 50: иначе часть дня просто не видна.
  const fallbackLimit = day || wantText ? 200 : 50;
  const limit = Math.min(
    Math.max(Number.isFinite(asked) && asked > 0 ? asked : fallbackLimit, 1),
    200,
  );

  const names = [];
  let cursor;
  do {
    const page = kv
      ? await kv.list({ prefix: CHAT_LOG_PREFIX, cursor })
      : { keys: [], list_complete: true };
    for (const key of page.keys || []) names.push(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const items = [];
  for (const name of names.sort().reverse()) {
    if (items.length >= limit) break;
    const raw = await kv.get(name);
    if (!raw) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (day && mskDay(record.ts) !== day) continue;
    items.push(record);
  }

  if (wantText) {
    return new Response(chatLogText([...items].reverse(), day), {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders(request, env) },
    });
  }

  return json({ total: names.length, items }, request, env);
}

/**
 * Суточный дайджест вопросов из виджета — по cron.
 *
 * Лог без напоминания не читают. Дайджест шлём только когда вопросы были:
 * пустое сообщение «0 вопросов» через неделю начнут игнорировать.
 *
 * @param {Record<string, unknown>} env
 * @param {KVNamespace | undefined} kv
 * @returns {Promise<{sent: number} | null>} сколько вопросов вошло в дайджест
 */
async function sendChatDigest(env, kv) {
  const owner = String(env.TELEGRAM_CHAT_ID || '');
  if (!env.TELEGRAM_BOT_TOKEN || !owner || !kv) return null;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const counted = new Map();
  let total = 0;
  let cursor;

  do {
    const page = await kv.list({ prefix: CHAT_LOG_PREFIX, cursor });
    for (const key of page.keys || []) {
      // Фильтр по времени — из самого ключа, без чтения значений там, где не надо.
      if (key.name.slice(CHAT_LOG_PREFIX.length) < since) continue;
      const raw = await kv.get(key.name);
      if (!raw) continue;
      const record = JSON.parse(raw);
      const phrase = String(record.q || '').toLowerCase().trim().slice(0, 120);
      counted.set(phrase, (counted.get(phrase) || 0) + 1);
      total += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (!total) return null;

  const top = [...counted.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([phrase, count]) => `${count}× ${phrase}`)
    .join('\n');

  await tgCall(env, 'sendMessage', {
    chat_id: owner,
    text: `Вопросы из виджета за сутки: ${total}\n\n${top}`,
    disable_web_page_preview: true,
  });

  return { sent: total };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Вход
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @param {Request} request
 * @param {Record<string, unknown>} env
 */
export default {
  async fetch(request, env, ctx) {
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

    if (request.method === 'POST' && pathname === '/api/tg/media') {
      return await handleTgMedia(request, env, env.LEADS);
    }

    if (request.method === 'GET' && pathname === '/api/tg/sources') {
      return await handleTgSources(request, env, env.LEADS);
    }

    if (request.method === 'GET' && pathname === '/api/tg/last') {
      return await handleTgLast(request, env, env.LEADS);
    }

    if (request.method === 'GET' && pathname === '/api/chat/log') {
      return await handleChatLog(request, env, env.LEADS);
    }

    if (request.method === 'POST' && pathname === '/api/tg/init') {
      return await handleTgInit(request, env);
    }

    if (request.method === 'POST' && pathname === '/api/dist/run') {
      return await handleDistRun(request, env, env.LEADS);
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
      return await handleChat(request, env, env.LEADS, ctx);
    } catch (e) {
      console.error('❌ Ошибка сервера:', e.message);
      return json({ error: 'server error' }, request, env, 500);
    }
  },

  /**
   * Cron: суточный дайджест вопросов из виджета (10:00 МСК).
   * Расписание — `triggers.crons` в `worker/wrangler.jsonc`.
   */
  async scheduled(event, env, ctx) {
    // Два независимых дела в одном триггере: дайджест лидов и подготовка
    // черновика на сегодня (ADR-005). Падение одного не должно останавливать
    // другое — поэтому отдельные обещания, а не последовательность.
    ctx.waitUntil(sendChatDigest(env, env.LEADS));
    ctx.waitUntil(
      prepareDueDraft(env, env.LEADS)
        .then((result) => {
          if (!result.ok) console.error('dist: очередь не отработала', result.reason);
        })
        .catch((e) => console.error('dist: очередь упала', e.message)),
    );
  },
};

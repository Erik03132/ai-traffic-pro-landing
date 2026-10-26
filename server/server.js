/**
 * Сервер приёма заявок и ответов чат-бота для AI-Traffic PRO.
 *
 * Два эндпоинта:
 *   POST /api/lead — заявка с формы → Telegram-бот владельца.
 *   POST /api/chat — вопрос из виджета → LLM (OpenRouter) + база знаний по услугам.
 *
 * Запуск: `node server/server.js` (порт из PORT, по умолчанию 3001).
 * Переменные окружения — см. `.env.example`.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ──────────────────────────────────────────────────────────────────────────
 * Конфигурация: .env читается вручную, чтобы не тянуть зависимость dotenv.
 * ────────────────────────────────────────────────────────────────────────── */
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const env = {
  ...loadEnv(path.join(__dirname, '.env')),
  ...loadEnv(path.join(__dirname, '..', '.env')),
  ...process.env,
};

const PORT = Number(env.PORT || 3001);
const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || '';
const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

/* ──────────────────────────────────────────────────────────────────────────
 * База знаний агента: короткие честные ответы по услугам.
 * Цитируются в ответах бота — источник правды, а не выдумка модели.
 * ────────────────────────────────────────────────────────────────────────── */
const KNOWLEDGE = [
  {
    keywords: ['услуги', 'направления', 'чем занимаетесь', 'что делаете'],
    answer:
      'Шесть направлений: 1) лидогенерация и продвижение, 2) SMM и ведение соцсетей, ' +
      '3) SEO и видимость в ИИ, 4) контекстная и таргетированная реклама, ' +
      '5) сайт или лендинг под ключ, 6) CRM и автоматизация маркетинга. ' +
      'Каждое работает отдельно, комплекс собираем под задачу.',
  },
  {
    keywords: ['сколько стоит', 'цена', 'стоимость', 'бюджет', 'прайс'],
    answer:
      'Стоимость — по запросу. Смета зависит от объёма работ и формата: считаем после короткой ' +
      'вводной, показываем, за что и сколько, и фиксируем в договоре. Вилки на сайте нет намеренно.',
  },
  {
    keywords: ['сроки', 'когда', 'сколько времени', 'быстро'],
    answer:
      'Первые выводы по трафику обычно появляются через 7–14 дней после запуска. ' +
      'Для SEO и контентных задач горизонт оценки дольше — фиксируем его в плане до старта. ' +
      'Лендинг — от 1,5–2 недель, сайт услуг — 3–5 недель.',
  },
  {
    keywords: ['договор', 'оплата', 'официально', 'ип', 'ооо'],
    answer:
      'Да, работаем по договору: фиксируем объём, сроки и критерии результата. ' +
      'Оплата — по согласованной модели: за запуск, ежемесячное ведение или комбинация.',
  },
  {
    keywords: ['отчет', 'отчёт', 'аналитика', 'метрики', 'как измеряете'],
    answer:
      'Раз в месяц — отчёт по обращениям, стоимости лида, расходам и выводам. ' +
      'В активных рекламных проектах дополнительно смотрим динамику каждую неделю. ' +
      'Формат и состав фиксируем в договоре.',
  },
  {
    keywords: ['заявк', 'форма', 'отправить', 'связаться', 'контакт'],
    answer:
      'Оставьте заявку через форму на сайте — отвечаем в течение рабочего дня. ' +
      'Или напишите в Telegram, это быстрее всего.',
  },
  {
    keywords: ['ai', 'ии', 'нейросет', 'искусственн'],
    answer:
      'AI используем для кабинетных исследований, анализа данных, генерации и теста гипотез, ' +
      'а также в продуктах: бот с FSM-онбордингом, CRM-автоматизация. ' +
      'Стратегия, финальные тексты и запуск остаются под контролем специалистов.',
  },
  {
    keywords: ['опыт', 'кейсы', 'клиенты', 'проекты', 'портфолио'],
    answer:
      'Публичного портфолио пока нет, поэтому мы не публикуем показатели клиентов без согласования. ' +
      'Вместо этого показываем метод: диагностика → гипотеза → замер → решение.',
  },
  {
    keywords: ['с чего начать', 'начать', 'первый шаг', 'диагностика'],
    answer:
      'С диагностики: смотрим продукт, экономику, спрос и доступные каналы. ' +
      'Предлагаем один канал, а не пять, и начинаем с узкого места, которое сильнее всего влияет на деньги.',
  },
];

/** Быстрый поиск по базе знаний. */
function findKnowledge(question) {
  const q = question.toLowerCase();
  const hits = KNOWLEDGE.filter((k) => k.keywords.some((word) => q.includes(word)));
  if (hits.length === 0) return null;
  return hits.map((h) => h.answer).join(' ');
}

/* ──────────────────────────────────────────────────────────────────────────
 * Telegram: отправка заявки менеджеру.
 * ────────────────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SERVICE_LABELS = {
  all: 'Весь комплекс',
  leadgen: 'Лидогенерация и продвижение',
  smm: 'SMM и ведение соцсетей',
  seo: 'SEO и видимость в ИИ',
  advertising: 'Контекстная и таргетированная реклама',
  landing: 'Сайт или лендинг под ключ',
  crm: 'CRM и автоматизация маркетинга',
  marketplace: 'Маркетплейс-настройка',
};

/**
 * Гарантированный бэкап лида на диск.
 *
 * Пока не настроен TELEGRAM_BOT_TOKEN, заявка не должна теряться: она
 * пишется в JSONL-файл по дням. Файл — источник правды для ручной обработки,
 * когда появится токен (или для ручной проверки ботов, попавших в спам).
 */
const LEADS_DIR = path.join(__dirname, 'leads');

function saveLeadToDisk(lead) {
  try {
    fs.mkdirSync(LEADS_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(LEADS_DIR, `${day}.jsonl`);
    fs.appendFileSync(
      file,
      JSON.stringify({ ...lead, receivedAt: new Date().toISOString() }) + '\n',
    );
    return file;
  } catch (e) {
    console.error('❌ Не удалось сохранить лид на диск:', e.message);
    return null;
  }
}

async function sendLeadToTelegram(lead) {
  // Всегда сначала сохраняем на диск: заявка не должна потеряться ни при каких
  // условиях — даже если Telegram недоступен.
  const file = saveLeadToDisk(lead);

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️  Telegram не настроен — лид сохранён на диск:', file);
    console.log('📋 Лид:', JSON.stringify(lead));
    return true; // Заявка принята — она на диске, не потеряна.
  }

  const serviceLabel = SERVICE_LABELS[lead.service] || lead.service || '—';
  const lines = [
    '🎯 <b>Новая заявка с сайта AI-Traffic PRO</b>',
    '',
    `👤 <b>Имя:</b> ${escapeHtml(lead.name || '—')}`,
    `📞 <b>Контакт:</b> ${escapeHtml(lead.contact || '—')}`,
    `🎯 <b>Услуга:</b> ${escapeHtml(serviceLabel)}`,
  ];

  if (lead.business) {
    lines.push(`🏢 <b>Компания / сайт:</b> ${escapeHtml(lead.business)}`);
  }
  if (lead.comment) {
    lines.push('', `📝 <b>О проекте:</b>\n${escapeHtml(lead.comment)}`);
  }
  if (lead.source) {
    lines.push('', `🔗 <b>Страница:</b> ${escapeHtml(lead.source)}`);
  }

  lines.push('', `🕐 ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (МСК)`);

  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error('❌ Telegram API отклонил сообщение:', data.description);
      console.warn('   Заявка сохранена на диск:', file);
      return true; // Не теряем заявку: она уже в файле.
    }
    console.log('✅ Заявка отправлена в Telegram');
    return true;
  } catch (e) {
    console.error('❌ Ошибка отправки заявки в Telegram:', e.message);
    console.warn('   Заявка сохранена на диск:', file);
    return true; // Не теряем заявку: она уже в файле.
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * LLM (OpenRouter). Используется только когда по базе знаний нет точного ответа.
 * ────────────────────────────────────────────────────────────────────────── */
const SYSTEM_PROMPT = [
  'Ты — агент маркетингового агентства AI-Traffic PRO (Россия).',
  'Отвечай по-русски, кратко (1–4 предложения), по делу, без рекламных превосходных степеней.',
  'Опирайся на КОНТЕКСТ. Если в контексте нет ответа — честно скажи, что уточнишь у команды,',
  'и предложи оставить заявку через форму или написать в Telegram.',
  'Не выдумывай цены, сроки, клиентов, кейсы и цифры. Стоимость — по запросу.',
].join(' ');

async function callLLM(messages) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY не задан');

  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://ai-traffic-pro.ru',
      'X-Title': 'AI-Traffic PRO',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 400,
    }),
  });

  const data = await resp.json();
  if (data.error || !data.choices?.[0]?.message?.content) {
    throw new Error(data.error?.message || 'неизвестная ошибка LLM');
  }
  return data.choices[0].message.content;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Rate limit: защита от спама (в памяти процесса).
 * ────────────────────────────────────────────────────────────────────────── */
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) return true;
  hits.push(now);
  requestLog.set(ip, hits);
  return false;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Валидация заявки.
 * ────────────────────────────────────────────────────────────────────────── */
function validateLead(payload) {
  const errors = [];
  const name = String(payload.name || '').trim();
  const contact = String(payload.contact || '').trim();
  const service = String(payload.service || '').trim();
  const business = String(payload.business || '')
    .trim()
    .slice(0, 200);
  const comment = String(payload.comment || '')
    .trim()
    .slice(0, 2000);
  const source = String(payload.source || '')
    .trim()
    .slice(0, 200);
  const consent =
    payload.consent === true || payload.consent === 'true' || payload.consent === 'on';

  if (name.length < 2) errors.push('name');
  if (contact.length < 5) errors.push('contact');
  if (!service) errors.push('service');
  if (!consent) errors.push('consent');

  // Honeypot: бот заполнил скрытое поле — принимаем, но никуда не отправляем.
  if (payload.website) return { ok: false, honeypot: true, errors: [] };

  return {
    ok: errors.length === 0,
    errors,
    lead: { name, contact, service, business, comment, source },
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * HTTP-сервер
 * ────────────────────────────────────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // Astro добавляет trailing slash (`trailingSlash: 'always'`), nginx может —
  // нет. Приводим к единому виду, иначе /api/chat/ не найдёт эндпоинт.
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  // CORS — тот же домен в проде, но dev-сервер Astro на другом порту.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ ok: true, telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) }),
    );
    return;
  }

  if (req.method !== 'POST' || (pathname !== '/api/chat' && pathname !== '/api/lead')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const clientIp = req.socket.remoteAddress ?? 'unknown';

  if (isRateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'rate limit',
        reply: 'Слишком много запросов. Подождите минуту.',
      }),
    );
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });

  req.on('end', async () => {
    try {
      const payload = JSON.parse(body || '{}');

      /* ── /api/lead ─────────────────────────────────────────────────────── */
      if (pathname === '/api/lead') {
        const validation = validateLead(payload);

        if (validation.honeypot) {
          // Бот: отвечаем «успех», но заявку никуда не отправляем.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (!validation.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, errors: validation.errors }));
          return;
        }

        const sent = await sendLeadToTelegram(validation.lead);
        res.writeHead(sent ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: sent }));
        return;
      }

      /* ── /api/chat ─────────────────────────────────────────────────────── */
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';

      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'empty message' }));
        return;
      }

      console.log(`💬 [${clientIp}] ${message.slice(0, 120)}`);

      // 1. База знаний — дешёвый и точный путь.
      const known = findKnowledge(message);
      if (known) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply: known, source: 'knowledge' }));
        return;
      }

      // 2. LLM — если база не помогла.
      const history = Array.isArray(payload.messages) ? payload.messages.slice(-8) : [];
      const llmMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history.map((t) => ({
          role: t.role === 'bot' ? 'assistant' : 'user',
          content: String(t.text ?? ''),
        })),
        { role: 'user', content: message },
      ];

      const reply = await callLLM(llmMessages);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply, source: 'llm' }));
    } catch (e) {
      console.error('❌ Ошибка сервера:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'server error' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 AI-Traffic PRO API: http://localhost:${PORT}`);
  console.log(
    `   Telegram: ${TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? 'настроен ✓' : 'НЕ настроен ✗ (заявки не уйдут)'}`,
  );
  console.log(
    `   LLM: ${OPENROUTER_API_KEY ? 'настроен ✓' : 'НЕ настроен ✗ (только база знаний)'}`,
  );
});

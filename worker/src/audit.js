/**
 * Публичный AI-аудит страницы: 0–100 и список правок.
 *
 * Зачем отдельный модуль. Внутренняя приёмка считается `tools/geo_lint.py`,
 * и он остаётся источником истины. Публичный аудит живёт в Cloudflare
 * Worker, где Python нет, поэтому здесь — порт тех же восьми блоков с теми
 * же весами. Паритет зафиксирован тестом `audit.test.js`: фикстура
 * `__fixtures__/article.html` даёт в обоих рантаймах 98/100 и одинаковую
 * разбивку по блокам. Меняете веса — меняйте оба файла и сверяйте прогоном
 * `python3 tools/geo_lint.py --file worker/src/__fixtures__/article.html`.
 *
 * Отличие от внутреннего линтера одно: «внутренняя ссылка» определяется по
 * origin проверяемого сайта, а не по домену ai-traffic-pro.ru — публичный
 * аудит работает с чужими сайтами.
 */

export const BLOCKS = [
  ['answer', 'Ответ в начале', 12],
  ['depth', 'Объём', 10],
  ['table', 'Таблица сравнения', 14],
  ['numbers', 'Цифры с единицами', 14],
  ['entities', 'Названные системы', 14],
  ['sources', 'Внешние источники', 10],
  ['structure', 'Структура и перелинковка', 12],
  ['schema', 'Разметка и автор', 14],
];

/** Названные системы: без имён страница не может стать источником ответа «что выбрать». */
const ENTITIES = [
  '1с', '1c', 'битрикс24', 'bitrix24', 'bitrix', 'amocrm', 'амосрм', 'salesforce',
  'sap', 'oracle', 'odoo', 'hubspot', 'dynamics', 'мойсклад', 'retailcrm',
  'yclients', 'мегаплан', 'megaplan', 'планфикс', 'zoho', 'erpnext',
  'класс365', 'аспро', 'sbercrm', 'битрикс', 'коммерсантъ', 'нетология',
  'ai overviews', 'ai mode', 'google ai', 'яндекс нейро', 'нейро', 'алиса',
  'chatgpt', 'perplexity', 'gemini', 'copilot', 'ahrefs', 'semrush',
  'search console', 'вебмастер', 'serpstat', 'similarweb',
  'яндекс директ', 'директ', 'vk реклама', 'vk ads', 'telegram ads',
  'авито', 'ozon', 'wildberries', 'яндекс маркет', 'метрика',
  'callibri', 'roistat', 'comagic', 'коллтач',
  'тильда', 'tilda', 'wordpress', '1с-битрикс',
  'вконтакте', 'vk видео', 'rutube', 'дзен', 'яндекс дзен', 'youtube',
  'astro', 'next.js', 'react', 'tailwind',
];

/** Соцсети и мессенджеры — не первоисточник. */
const SOCIAL = [
  'vk.com', 't.me', 'telegram', 'youtube', 'youtu.be', 'facebook', 'instagram',
  'twitter', 'x.com', 'wa.me', 'whatsapp', 'linkedin', 'dzen.ru', 'zen.yandex',
  'rutube', 'tiktok', 'pinterest',
];

const COMPARATIVE = /разниц|отлича|сравн|vs|\bили\b|что выбрать|что лучше|какой выбрать|чем.*лучше|difference|versus/i;

const NUM_UNITS = /\b\d+(?:[.,]\d+)?\s*(?:%|руб|₽|тыс|млн|млрд|дн[яей]*|недел\w*|мес\w*|год\w*|лет|час\w*|минут\w*|сотрудник\w*|пользовател\w*|заявок|заявк\w*|этап\w*|шаг\w*|клиент\w*|компан\w*)/gi;

const HELP_PATHS = /\/(help|support|business|developers|docs|blog)/;

/* ────────────────────────── разбор HTML ────────────────────────── */

const TAG_RE = /<!--[\s\S]*?-->|<!\w[^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg']);
const ICON_TAGS = new Set(['span', 'i', 'em']);

function attrs(raw) {
  const out = {};
  if (!raw) return out;
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

/**
 * Собирает то же, что `html.parser`-класс в geo_lint.py: заголовки, ссылки,
 * таблицы и текст внутри <article>/<main>.
 */
export function parsePage(html) {
  const p = {
    title: '',
    meta: {},
    canonical: '',
    headings: [],
    links: [],
    tables: 0,
    images: 0,
    ldjson: [],
    textRegion: '',
    firstH2Pos: null,
    firstH2PosAll: null,
    sawArticle: false,
  };

  let skip = 0;
  let icon = 0;
  let art = 0;
  let main = 0;
  let inLd = false;
  const bufArt = [];
  const bufMain = [];
  const bufAll = [];
  let curH = null;
  let curA = null;

  const regionBuf = () => (art > 0 ? bufArt : main > 0 && !p.sawArticle ? bufMain : bufArt);
  const inRegion = () => art > 0 || (main > 0 && !p.sawArticle);
  const wordCount = (t) => (t.match(/[A-Za-zА-Яа-яЁё0-9]+/g) || []).length;

  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;

  const data = (chunk) => {
    if (!chunk) return;
    if (inLd) {
      if (p.ldjson.length) p.ldjson[p.ldjson.length - 1] += chunk;
      return;
    }
    if (skip || icon) return;
    if (curH) curH.parts.push(chunk);
    if (curA) curA.parts.push(chunk);
    if (inRegion()) regionBuf().push(chunk);
    bufAll.push(chunk);
  };

  while ((m = TAG_RE.exec(html))) {
    data(html.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1];
    const tag = (closing || m[2] || '').toLowerCase();
    if (!tag) continue;
    const a = m[2] ? attrs(m[3]) : {};

    if (closing) {
      if (ICON_TAGS.has(tag) && icon) {
        icon -= 1;
        continue;
      }
      if (SKIP_TAGS.has(tag) && skip) {
        skip -= 1;
        if (tag === 'script') inLd = false;
      } else if (tag === 'article') art = Math.max(0, art - 1);
      else if (tag === 'main') main = Math.max(0, main - 1);

      if ((tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'title') && curH) {
        const text = curH.parts.join('').replace(/\s+/g, ' ').trim();
        if (curH.level === 0) p.title = text;
        else if (text) p.headings.push({ level: curH.level, text, inRegion: inRegion() });
        curH = null;
      } else if (tag === 'a' && curA) {
        p.links.push({
          href: curA.href,
          anchor: curA.parts.join('').replace(/\s+/g, ' ').trim(),
          inRegion: inRegion(),
        });
        curA = null;
      }
      if (tag === 'script') inLd = false;
      continue;
    }

    if (tag === 'script' && /ld\+json/i.test(a.type || '')) {
      inLd = true;
      p.ldjson.push('');
      skip += 1;
    } else if (SKIP_TAGS.has(tag)) {
      skip += 1;
    } else if (ICON_TAGS.has(tag) && /material-(symbols|icons)/.test(a.class || '')) {
      icon += 1;
    } else if (tag === 'article') {
      art += 1;
      p.sawArticle = true;
    } else if (tag === 'main') {
      main += 1;
    } else if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      curH = { level: Number(tag[1]), parts: [] };
      if (tag === 'h2' && p.firstH2Pos === null && inRegion()) {
        p.firstH2Pos = wordCount(regionBuf().join(' '));
      }
      if (tag === 'h2' && p.firstH2PosAll === null) {
        p.firstH2PosAll = wordCount(bufAll.join(' '));
      }
    } else if (tag === 'a' && a.href) {
      curA = { href: a.href.trim(), parts: [] };
    } else if (tag === 'table') {
      p.tables += 1;
    } else if (tag === 'img') {
      p.images += 1;
    } else if (tag === 'title') {
      curH = { level: 0, parts: [] };
    } else if (tag === 'meta') {
      if (a.name) p.meta[a.name.toLowerCase()] = a.content || '';
      if (a.property) p.meta[a.property.toLowerCase()] = a.content || '';
    } else if (tag === 'link' && /canonical/.test(a.rel || '')) {
      p.canonical = a.href || '';
    }
  }
  data(html.slice(last));

  p.textRegion = (p.sawArticle ? bufArt : bufMain).join(' ').replace(/\s+/g, ' ').trim();
  return p;
}

function plain(html) {
  return html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (t) => (t.match(/[A-Za-zА-Яа-яЁё0-9]+/g) || []).length;

function entityHits(text) {
  const low = text.toLowerCase();
  const found = new Set();
  for (const e of ENTITIES) {
    const at = low.indexOf(e);
    if (at === -1) continue;
    const before = low[at - 1] || '';
    const after = low[at + e.length] || '';
    const bad = (ch) => /[а-яa-z]/.test(ch);
    if (!bad(before) && !bad(after)) found.add(e);
  }
  return [...found].sort();
}

/** Правила 8 блоков — зеркало `analyse()` в tools/geo_lint.py. */
export function analyze(html, { url = '', query = '' } = {}) {
  const p = parsePage(html || '');
  const text = p.textRegion || plain(html || '');
  const wc = words(text);
  const comparative = Boolean(query && COMPARATIVE.test(query));

  let arts = p.headings.filter((h) => h.inRegion);
  if (!p.sawArticle && !/<\/?main/i.test(html || '')) arts = p.headings;
  const h2 = arts.filter((h) => h.level === 2);
  const h3 = arts.filter((h) => h.level === 3);

  let before = p.firstH2Pos;
  if (before === null) before = h2.length ? p.firstH2PosAll ?? wc : wc;

  const nums = new Set(text.match(NUM_UNITS) || []).size;
  const ents = entityHits(text);

  let rlinks = p.links.filter((l) => l.inRegion);
  if (!p.sawArticle && !/<\/?main/i.test(html || '')) rlinks = p.links;

  let origin = '';
  try {
    origin = url ? new URL(url).origin : '';
  } catch {
    origin = '';
  }

  const internal = [];
  const external = [];
  for (const { href, anchor } of rlinks) {
    if (!href || href.startsWith('#') || /^mailto:/i.test(href)) continue;
    const isInternal =
      href.startsWith('/') ||
      (origin && (href.startsWith(origin) || href.startsWith(origin.replace(/^https?:/, ''))));
    if (isInternal) internal.push({ href, anchor });
    else if (!SOCIAL.some((s) => href.includes(s)) || HELP_PATHS.test(href)) external.push({ href, anchor });
  }

  const ld = p.ldjson.join(' ').toLowerCase();
  const hasPost =
    /"blogposting"|"article"|"newsarticle"|"techarticle"/.test(ld) ||
    /"@type"\s*:\s*"(service|product)"/.test(ld);
  const hasFaq = ld.includes('"faqpage"');
  const authorMeta = p.meta.author || '';
  const person =
    /"author"\s*:\s*\{[^}]*"@type"\s*:\s*"(person|people)"/.test(ld) ||
    (Boolean(authorMeta) && !['', 'admin'].includes(authorMeta.toLowerCase())) ||
    p.links.some((l) => (l.href || '').includes('/author/'));

  const s = {};

  // Отличие от geo_lint.py: страница без содержания не получает балл
  // за «короткое вступление». Иначе пустой URL даёт 12/100 и отчёт врёт.
  s.answer = wc < 100 ? 0 : before <= 120 ? 12 : before <= 200 ? 9 : before <= 320 ? 5 : 0;

  s.depth = wc >= 1500 ? 10 : wc >= 1200 ? 8 : wc >= 900 ? 5 : wc >= 600 ? 2 : 0;

  s.table = p.tables ? 14 : 0;

  s.numbers = nums >= 5 ? 14 : nums >= 3 ? 10 : nums >= 1 ? 5 : 0;

  const n = ents.length;
  s.entities = n >= 5 ? 14 : n >= 3 ? 9 : n >= 1 ? 4 : 0;

  const linkCount = external.length;
  s.sources = linkCount >= 3 ? 10 : linkCount >= 2 ? 8 : linkCount >= 1 ? 4 : 0;

  s.structure =
    (h3.length >= 3 && h2.length >= 4 ? 6 : h2.length >= 4 ? 3 : 0) +
    (internal.length >= 2 ? 6 : internal.length === 1 ? 3 : 0);

  s.schema = (hasPost ? 5 : 0) + (hasFaq ? 4 : 0) + (person ? 5 : 0);

  const fixes = [];
  if (s.answer < 9) {
    fixes.push(
      `Сжать вступление: до первого H2 сейчас ${before} слов, нужно ≤120. Прямой ответ — в первом абзаце.`,
    );
  }
  if (s.depth < 8) {
    fixes.push(`Объём ${wc} слов — мало для конкуренции. Довести до 1200–1800 без воды.`);
  }
  if (!p.tables) {
    fixes.push(
      `${comparative ? 'Для сравнительного запроса это критично: ' : ''}добавить настоящую <table> сравнения на 8–10 строк, а не список с галочками.`,
    );
  }
  if (s.numbers < 10) {
    fixes.push(
      `Чисел с единицами ${nums}, нужно ≥3: сроки внедрения, бюджеты, проценты, количество сотрудников.`,
    );
  }
  if (n < 3) {
    fixes.push('Назвать системы по именам с привязкой к ситуации: 1С, Битрикс24, amoCRM, Odoo, SAP.');
  }
  if (linkCount < 2) {
    fixes.push(`Внешних источников ${linkCount}, нужно ≥2: первоисточники по теме, ссылка в том же предложении.`);
  }
  if (h3.length < 3) {
    fixes.push(`H3 внутри H2 сейчас ${h3.length}. Без подразделов страницу не выдёргивают по отдельному абзацу.`);
  }
  if (internal.length < 2) {
    fixes.push(`Контекстных внутренних ссылок ${internal.length}, нужно ≥2 — в тело текста, а не карточками.`);
  }
  if (!hasPost) {
    fixes.push('Нет главной сущности страницы в JSON-LD: BlogPosting для статьи, Service для услуги.');
  }
  if (!hasFaq) {
    fixes.push('Нет FAQPage — добавить 3–5 вопросов с короткими ответами.');
  }
  if (!person) {
    fixes.push('Автор не назван человеком. Одна строка опыта под материалом — это E-E-A-T и доверие ИИ.');
  }

  const total = Object.values(s).reduce((a, b) => a + b, 0);

  return {
    score: total,
    max: 100,
    blocks: BLOCKS.map(([key, label, max]) => ({ key, label, score: s[key], max })),
    metrics: {
      words: wc,
      words_before_first_h2: before,
      tables: p.tables,
      images: p.images,
      numbers: nums,
      entities: ents,
      external_links: linkCount,
      internal_links: internal.length,
      h2: h2.length,
      h3: h3.length,
      comparative,
    },
    meta: {
      title: p.title,
      title_len: p.title.length,
      description_len: (p.meta.description || '').length,
      canonical: p.canonical,
      has_person: person,
      has_blogposting: hasPost,
      has_faqpage: hasFaq,
    },
    fixes,
  };
}

/* ────────────────────────── проверки сайта ────────────────────────── */

const SITE_FILES = ['robots.txt', 'llms.txt', 'sitemap.xml'];

/** robots.txt, llms.txt, sitemap.xml — то, что решает, увидят ли страницу ИИ-боты. */
export async function checkSite(origin, fetchText) {
  const out = {};
  const results = await Promise.all(
    SITE_FILES.map(async (file) => {
      try {
        const body = await fetchText(`${origin}/${file}`, 60_000);
        return [file, body];
      } catch {
        return [file, null];
      }
    }),
  );
  const map = Object.fromEntries(results);

  const robots = map['robots.txt'];
  out.robots = {
    found: robots !== null,
    blocks_ai_bots:
      robots !== null &&
      /user-agent:\s*(gptbot|perplexitybot|claudebot|ccbot)/i.test(robots) &&
      /disallow:\s*\/\s*$/im.test(robots),
    declares_ai: robots !== null && /(gptbot|perplexitybot|claudebot|yandexgpt)/i.test(robots),
  };

  const llms = map['llms.txt'];
  out.llms = { found: llms !== null, size: llms ? llms.length : 0 };

  const sitemap = map['sitemap.xml'];
  out.sitemap = {
    found: sitemap !== null,
    urls: sitemap ? (sitemap.match(/<loc>/gi) || []).length : 0,
    listed_in_robots: robots ? /sitemap:/i.test(robots) : false,
  };
  return out;
}

/* ────────────────────────── безопасность ────────────────────────── */

export class AuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
  }
}

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata',
  'instance-data',
]);

function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateHost(mapped[1]);
  }
  return false;
}

/**
 * Проверяет адрес до запроса. Аудит ходит по чужим URL — без этого фильтра
 * сервис превращается в способ дотянуться до внутренней сети и метаданных
 * облака (SSRF).
 */
export function safeUrl(raw) {
  let value = String(raw ?? '').trim();
  if (!value) throw new AuditError('EMPTY', 'Укажите адрес страницы');
  if (value.length > 2048) throw new AuditError('BAD_URL', 'Слишком длинный адрес');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AuditError('BAD_URL', 'Не удалось разобрать адрес — проверьте написание');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuditError('BAD_URL', 'Поддерживаются только http и https');
  }
  if (url.username || url.password) {
    throw new AuditError('BAD_URL', 'Адреса с логином и паролем не проверяются');
  }
  if (isPrivateHost(url.hostname)) {
    throw new AuditError('PRIVATE_HOST', 'Внутренние и локальные адреса не проверяются');
  }
  url.hash = '';
  return url;
}

const MAX_BYTES = 400_000;

async function readLimited(response, limit = MAX_BYTES) {
  const contentType = response.headers.get('content-type') || '';
  const buffer = await response.arrayBuffer();
  const slice = buffer.byteLength > limit ? buffer.slice(0, limit) : buffer;
  let charset = 'utf-8';
  const m = /charset=([^;]+)/i.exec(contentType);
  if (m) charset = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
  try {
    return new TextDecoder(charset).decode(slice);
  } catch {
    return new TextDecoder('utf-8').decode(slice);
  }
}

async function fetchWithTimeout(fetchImpl, url, { timeout = 12_000, limit = MAX_BYTES, accept } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ai-traffic-audit/1.0; +https://ai-traffic-pro.ru/audit/)',
        accept: accept || 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) throw new AuditError('HTTP', `Сайт ответил ${res.status}`);
    return await readLimited(res, limit);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Полный аудит: страница + site-файлы. `fetchImpl` инжектится, чтобы тесты
 * не ходили в сеть.
 */
export async function auditUrl(rawUrl, { query = '', fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const url = safeUrl(rawUrl);
  const startedAt = now();

  let html;
  try {
    html = await fetchWithTimeout(fetchImpl, url.href, { accept: 'text/html,application/xhtml+xml' });
  } catch (err) {
    if (err instanceof AuditError) throw err;
    if (err && err.name === 'AbortError') throw new AuditError('TIMEOUT', 'Сайт не ответил за 12 секунд');
    throw new AuditError('FETCH', 'Не удалось загрузить страницу');
  }

  const report = analyze(html, { url: url.href, query });

  let site = null;
  try {
    site = await checkSite(url.origin, (u, limit) => fetchWithTimeout(fetchImpl, u, { timeout: 6000, limit }));
  } catch {
    site = null;
  }

  return {
    url: url.href,
    checked_at: new Date(startedAt).toISOString(),
    ...report,
    site,
    notes: buildNotes(report, site),
  };
}

function buildNotes({ meta }, site) {
  const notes = [];
  if (meta.description_len === 0) notes.push('Нет meta description — сниппет в выдаче соберётся случайно.');
  else if (meta.description_len > 200) notes.push(`meta description ${meta.description_len} символов — обрежется, оптимально 120–160.`);
  if (meta.title_len > 70) notes.push(`title ${meta.title_len} символов — обрежется в выдаче.`);
  if (site) {
    if (!site.llms.found) notes.push('Нет llms.txt — ИИ-агентам нечего читать о компании, кроме самой страницы.');
    if (!site.sitemap.found) notes.push('Нет sitemap.xml — поисковику сложнее обойти разделы.');
    if (site.robots.blocks_ai_bots) notes.push('robots.txt закрывает AI-ботов — страница не попадёт в ответы нейросетей.');
    if (site.sitemap.found && !site.sitemap.listed_in_robots) notes.push('sitemap.xml не объявлен в robots.txt.');
  }
  return notes;
}

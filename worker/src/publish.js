/**
 * Публикация постов в Telegram с подтверждением.
 *
 * Задача: черновик приходит владельцу канала в личный чат с ботом, под ним
 * две кнопки — «Опубликовать» и «Отклонить». Публикация — только по нажатию:
 * бот не постит сам, чтобы в канал не уходил текст с опечаткой.
 *
 * Здесь только чистые функции (разметка, ссылка, клавиатуры) — их проверяют
 * тесты `publish.test.js`. Сеть и KV живут в `index.js`.
 */

/** Лимит Telegram на текст сообщения. */
export const POST_LIMIT = 4096;

/**
 * Лимит Telegram на подпись к фото.
 *
 * Отдельная константа, а не «тот же 4096»: пост с картинкой физически короче,
 * и это не баг, а формат ленты. Проверяем заранее, чтобы не узнать об этом
 * от Telegram после нажатия «Опубликовать».
 */
export const CAPTION_LIMIT = 1024;

/** Лимит Telegram на `callback_data`. */
export const CALLBACK_LIMIT = 64;

/** Сайт по умолчанию, если переменная окружения не задана. */
const DEFAULT_SITE = 'https://ai-traffic-pro.ru';

/** Слаг статьи: строчные латинские буквы, цифры и дефис. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Ссылка вида `[фраза](https://…|{{link}})`. */
const LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Проверяет, что слаг безопасен для ключа KV и `callback_data`. */
export function isSlug(value) {
  return SLUG_RE.test(String(value || ''));
}

/**
 * Проверяет адрес картинки для поста.
 *
 * Только http(s) и только абсолютный адрес: Telegram сам скачивает файл по
 * ссылке, поэтому локальный путь или `data:` не сработают. Длина ограничена —
 * адрес уезжает в `callback_data`-соседа (ключ черновика) и в запрос к API.
 */
export function isPhotoUrl(value) {
  const raw = String(value || '');
  if (!raw || raw.length > 500) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Экранирует текст для `parse_mode: HTML`. */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Собирает адрес статьи с UTM-метками.
 * `utm_content` различает несколько постов про одну статью.
 */
export function buildLink(slug, content = '', site = DEFAULT_SITE) {
  const url = new URL(`/blog/${slug}/`, site);
  url.searchParams.set('utm_source', 'telegram');
  url.searchParams.set('utm_medium', 'social');
  url.searchParams.set('utm_campaign', slug);
  if (content) url.searchParams.set('utm_content', content);
  return url.toString();
}

/**
 * Склеивает жёсткие переносы внутри абзаца и внутри пункта списка.
 *
 * Зачем: текст поста пишется в редакторе и переносится по 78 знаков, а
 * Telegram показывает перенос как есть — пост превращается в рваный столбик.
 * Абзац отделяется пустой строкой; строки, начинающиеся с маркера списка,
 * остаются отдельными пунктами, их «хвосты» приклеиваются к пункту.
 *
 * @param {string} text черновик как его написали
 * @returns {string} текст, где перенос значит смысловой разрыв, а не вёрстку
 */
export function reflow(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      const out = [];
      for (const line of lines) {
        const isItem = /^([•*\-–—]|\d+[.)])\s+/.test(line);
        if (isItem || out.length === 0) out.push(line);
        else out[out.length - 1] += ` ${line}`;
      }
      return out.join('\n');
    })
    .join('\n\n');
}

/** Строка-заголовок: `#`, `##` или `###` и текст после них. */
const HEADING_RE = /^#{1,6}\s+(.*)$/;

/** `**жирный**` — единственное выделение, которое встречается в текстах. */
const BOLD_RE = /\*\*([^*\n]+)\*\*/g;

/**
 * `**жирный**` → `<b>…</b>` на уже экранированном тексте.
 * Порядок важен: сначала escape, потом теги — иначе `<` из текста станет тегом.
 */
function withBold(escaped) {
  return escaped.replace(BOLD_RE, '<b>$1</b>');
}

/**
 * Инлайн-разметка строки: `[фраза]({{link}})` и `**жирный**` → HTML.
 * `{{link}}` подставляется готовым адресом с метками, чтобы слаг и UTM не
 * дублировались в каждом тексте руками.
 */
function inlineToHtml(text, linkUrl) {
  let html = '';
  let last = 0;

  for (const match of text.matchAll(LINK_RE)) {
    const [whole, label, rawTarget] = match;
    const target = rawTarget === '{{link}}' ? linkUrl : rawTarget;

    if (!/^https:\/\//.test(target)) throw new Error('ссылка должна быть https');

    html += withBold(escapeHtml(text.slice(last, match.index)));
    html += `<a href="${escapeHtml(target)}">${withBold(escapeHtml(label))}</a>`;
    last = match.index + whole.length;
  }

  return html + withBold(escapeHtml(text.slice(last)));
}

/**
 * Превращает черновик в HTML для Telegram.
 *
 * Разметка намеренно бедная: ссылки `[фраза]({{link}})`, `**жирный**` и
 * заголовки `##`. Без этого `##` уезжал в канал решётками, а выделение —
 * звёздочками: пост в канале выглядел как необработанный черновик.
 *
 * @param {string} markdown Черновик поста.
 * @param {string} linkUrl Адрес статьи с UTM.
 * @throws {Error} если текст длиннее лимита или ссылка не https.
 */
export function renderPost(markdown, linkUrl) {
  const src = reflow(String(markdown ?? '').trim());

  if (!src) throw new Error('пустой пост');
  if (src.length > POST_LIMIT) throw new Error(`пост длиннее ${POST_LIMIT} символов`);

  return src
    .split('\n')
    .map((line) => {
      const heading = line.match(HEADING_RE);
      if (!heading) return inlineToHtml(line, linkUrl);

      const html = inlineToHtml(heading[1], linkUrl);
      // Уже жирный — второй <b> не нужен: Telegram не любит вложенные теги.
      return html.includes('<b>') ? html : `<b>${html}</b>`;
    })
    .join('\n');
}

/** Ключ черновика в KV: слаг плюс метка поста (`post-1`), если есть. */
export function draftKey(slug, content = '') {
  return content ? `draft:tg:${slug}:${content}` : `draft:tg:${slug}`;
}

/** Хвост `callback_data`: слаг и метка поста. */
function payloadOf(slug, content = '') {
  if (!isSlug(slug)) throw new Error('плохой слаг');
  const tail = content ? `${slug}:${content}` : slug;
  if (tail.length > CALLBACK_LIMIT - 6) throw new Error('callback_data длиннее лимита');
  return tail;
}

/**
 * Клавиатура черновика: публикация или отказ.
 * `content` различает несколько постов про одну статью (`post-1`, `post-2`).
 */
export function draftKeyboard(slug, content = '') {
  const tail = payloadOf(slug, content);

  return {
    inline_keyboard: [
      [
        { text: '✅ Опубликовать в канал', callback_data: `tgpub:${tail}` },
        { text: '❌ Отклонить', callback_data: `tgdrop:${tail}` },
      ],
    ],
  };
}

/** Клавиатура опубликованного поста: кнопка-ссылка вместо простыни. */
export function channelKeyboard(linkUrl) {
  return { inline_keyboard: [[{ text: 'Читать статью →', url: linkUrl }]] };
}

/** Разбирает `callback_data` вида `tgpub:<slug>` или `tgpub:<slug>:<post>`. */
export function parseCallback(data) {
  const [action, slug, content = ''] = String(data || '').split(':');
  if (!isSlug(slug)) return { action: 'unknown', slug: '', content: '' };
  if (action !== 'tgpub' && action !== 'tgdrop') return { action: 'unknown', slug, content };
  return { action, slug, content: content.slice(0, 20) };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Очередь публикаций (ADR-005, этап 2)
 * ────────────────────────────────────────────────────────────────────────── */

/** Адрес манифеста очереди на сайте. */
export function manifestUrl(site = DEFAULT_SITE) {
  return `${String(site || DEFAULT_SITE).replace(/\/+$/, '')}/distribution/manifest.json`;
}

/**
 * Сегодняшняя дата по Москве.
 *
 * Cron Cloudflare живёт в UTC: в 00:00 UTC в Москве уже 03:00, а в 21:00 UTC —
 * ещё сегодня. Планы в реестре записаны по МСК, поэтому сравнивать их с
 * `toISOString()` напрямую нельзя — пост ушёл бы днём раньше.
 */
export function todayMsk(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** id публикации так, как он записан в реестре: канал в id входит. */
export function publicationId(slug, content = '') {
  return `${slug}${content ? `:${content}` : ''}:telegram`;
}

/** Ключ «черновик уже отправлен»: защита от ежедневного повтора. */
export function draftSentKey(id) {
  return `sent:tg:${id}`;
}

/** Ключ «пост уже вышел»: защита от повторной публикации. */
export function publishedKey(id) {
  return `pub:tg:${id}`;
}

/** Статусы, которые ждут выхода в канал. */
const DUE_STATUSES = new Set(['queued', 'approved']);

/**
 * Что публиковать сегодня.
 *
 * Условия: статус ждёт выхода, дата наступила (или прошла), текст в манифесте
 * есть. Публикации без `plannedAt` в очередь не попадают: реестр с пустой
 * датой — это «ещё не решили», а не «опубликуй сейчас».
 *
 * Сортировка по дате, затем по id — cron берёт первую, остальные ждут
 * следующего запуска: два поста в один день не выходят.
 */
export function duePublications(items, today) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item === 'object')
    .filter((item) => DUE_STATUSES.has(String(item.status || '')))
    .filter((item) => String(item.channel || 'telegram') === 'telegram')
    .filter((item) => typeof item.text === 'string' && item.text.trim().length > 0)
    .filter((item) => item.plannedAt && String(item.plannedAt) <= today)
    .sort((a, b) => {
      const left = String(a.plannedAt);
      const right = String(b.plannedAt);
      if (left !== right) return left < right ? -1 : 1;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
}

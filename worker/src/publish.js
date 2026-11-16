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

/**
 * Превращает черновик в HTML для Telegram.
 *
 * Разметка намеренно бедная: `[фраза]({{link}})` — единственное, что нужно
 * автору. `{{link}}` подставляется готовым адресом с метками, чтобы слаг и
 * UTM не дублировались в каждом тексте руками.
 *
 * @param {string} markdown Черновик поста.
 * @param {string} linkUrl Адрес статьи с UTM.
 * @throws {Error} если текст длиннее лимита или ссылка не https.
 */
export function renderPost(markdown, linkUrl) {
  const src = reflow(String(markdown ?? '').trim());

  if (!src) throw new Error('пустой пост');
  if (src.length > POST_LIMIT) throw new Error(`пост длиннее ${POST_LIMIT} символов`);

  let html = '';
  let last = 0;

  for (const match of src.matchAll(LINK_RE)) {
    const [whole, label, rawTarget] = match;
    const target = rawTarget === '{{link}}' ? linkUrl : rawTarget;

    if (!/^https:\/\//.test(target)) throw new Error('ссылка должна быть https');

    html += escapeHtml(src.slice(last, match.index));
    html += `<a href="${escapeHtml(target)}">${escapeHtml(label)}</a>`;
    last = match.index + whole.length;
  }

  html += escapeHtml(src.slice(last));
  return html;
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

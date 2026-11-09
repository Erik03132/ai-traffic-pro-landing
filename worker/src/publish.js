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
  const src = String(markdown ?? '').trim();

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

/** Клавиатура черновика: публикация или отказ. */
export function draftKeyboard(slug) {
  if (!isSlug(slug)) throw new Error('плохой слаг');
  const data = `tgpub:${slug}`;
  if (data.length > CALLBACK_LIMIT) throw new Error('callback_data длиннее лимита');

  return {
    inline_keyboard: [
      [
        { text: '✅ Опубликовать в канал', callback_data: data },
        { text: '❌ Отклонить', callback_data: `tgdrop:${slug}` },
      ],
    ],
  };
}

/** Клавиатура опубликованного поста: кнопка-ссылка вместо простыни. */
export function channelKeyboard(linkUrl) {
  return { inline_keyboard: [[{ text: 'Читать статью →', url: linkUrl }]] };
}

/** Разбирает `callback_data` вида `tgpub:<slug>`. */
export function parseCallback(data) {
  const [action, slug] = String(data || '').split(':');
  if (!isSlug(slug)) return { action: 'unknown', slug: '' };
  if (action !== 'tgpub' && action !== 'tgdrop') return { action: 'unknown', slug };
  return { action, slug };
}

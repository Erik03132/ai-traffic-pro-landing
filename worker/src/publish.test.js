import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALLBACK_LIMIT,
  CAPTION_LIMIT,
  POST_LIMIT,
  buildLink,
  channelKeyboard,
  draftKeyboard,
  draftKey,
  escapeHtml,
  isPhotoUrl,
  isSlug,
  parseCallback,
  reflow,
  renderPost,
} from './publish.js';

/* ── Ссылка с метками ────────────────────────────────────────────────── */

test('buildLink: слэш на конце, utm_source=telegram и кампания = слаг', () => {
  const link = buildLink('crm-i-erp-raznica');

  assert.match(link, /^https:\/\/ai-traffic-pro\.ru\/blog\/crm-i-erp-raznica\/\?/);
  const params = new URL(link).searchParams;
  assert.equal(params.get('utm_source'), 'telegram');
  assert.equal(params.get('utm_medium'), 'social');
  assert.equal(params.get('utm_campaign'), 'crm-i-erp-raznica');
  assert.equal(params.get('utm_content'), null);
});

test('buildLink: utm_content различает посты про одну статью', () => {
  const params = new URL(buildLink('voronka', 'post-2')).searchParams;
  assert.equal(params.get('utm_content'), 'post-2');
});

test('buildLink: сайт можно подменить (нужно тестам и превью)', () => {
  const link = buildLink('seo', '', 'https://example.test');
  assert.match(link, /^https:\/\/example\.test\/blog\/seo\//);
});

test('isSlug: пропускает нормальные слаги и отсекает мусор', () => {
  assert.equal(isSlug('crm-i-erp-raznica'), true);
  assert.equal(isSlug(''), false);
  assert.equal(isSlug('CRM'), false);
  assert.equal(isSlug('../../etc/passwd'), false);
  assert.equal(isSlug('a'.repeat(41)), false);
});

/* ── Разметка поста ──────────────────────────────────────────────────── */

const LINK = 'https://ai-traffic-pro.ru/blog/test/?utm_source=telegram';

test('renderPost: подставляет адрес в {{link}} и делает ссылку', () => {
  const html = renderPost('Подробно — [в статье]({{link}}).', LINK);

  assert.equal(html, `Подробно — <a href="${LINK}">в статье</a>.`);
});

test('renderPost: внешнюю https-ссылку оставляет как есть', () => {
  const html = renderPost('Источник: [отчёт](https://example.test/report).', LINK);
  assert.match(html, /href="https:\/\/example\.test\/report"/);
});

test('renderPost: экранирует HTML в тексте', () => {
  const html = renderPost('CRM < ERP & «учёт»', LINK);

  assert.equal(html, 'CRM &lt; ERP &amp; «учёт»');
  assert.ok(!html.includes('<'));
});

test('renderPost: http-ссылку не пропускает', () => {
  assert.throws(() => renderPost('[статья](http://example.test)', LINK), /https/);
});

test('renderPost: пустой пост и перебор лимита — ошибка', () => {
  assert.throws(() => renderPost('', LINK), /пустой/);
  assert.throws(() => renderPost('а'.repeat(POST_LIMIT + 1), LINK), /длиннее/);
});

test('renderPost: несколько ссылок и текст между ними не теряется', () => {
  const html = renderPost('Начало [раз]({{link}}) середина [два]({{link}}) конец', LINK);
  assert.equal((html.match(/<a href=/g) || []).length, 2);
  assert.match(html, /^Начало <a /);
  assert.match(html, /конец$/);
});

/* ── Клавиатуры ──────────────────────────────────────────────────────── */

test('draftKeyboard: две кнопки, callback_data в лимите', () => {
  const kb = draftKeyboard('crm-i-erp-raznica');
  const [publishBtn, dropBtn] = kb.inline_keyboard[0];

  assert.match(publishBtn.text, /Опубликовать/);
  assert.equal(publishBtn.callback_data, 'tgpub:crm-i-erp-raznica');
  assert.ok(publishBtn.callback_data.length <= CALLBACK_LIMIT);
  assert.equal(dropBtn.callback_data, 'tgdrop:crm-i-erp-raznica');
});

test('draftKeyboard: метка поста различает черновики одной статьи', () => {
  const kb = draftKeyboard('crm-i-erp-raznica', 'post-2');
  assert.equal(kb.inline_keyboard[0][0].callback_data, 'tgpub:crm-i-erp-raznica:post-2');
  assert.ok(kb.inline_keyboard[0][0].callback_data.length <= CALLBACK_LIMIT);
});

test('draftKey: с меткой поста и без неё', () => {
  assert.equal(draftKey('voronka'), 'draft:tg:voronka');
  assert.equal(draftKey('voronka', 'post-2'), 'draft:tg:voronka:post-2');
});

test('draftKeyboard: плохой слаг — ошибка, а не битая кнопка', () => {
  assert.throws(() => draftKeyboard('../../etc'), /слаг/);
});

test('channelKeyboard: одна кнопка-ссылка на статью', () => {
  const kb = channelKeyboard(LINK);
  assert.deepEqual(kb, { inline_keyboard: [[{ text: 'Читать статью →', url: LINK }]] });
});

test('parseCallback: разбирает публикацию, отказ и мусор', () => {
  assert.deepEqual(parseCallback('tgpub:voronka'), { action: 'tgpub', slug: 'voronka', content: '' });
  assert.deepEqual(parseCallback('tgpub:voronka:post-2'), {
    action: 'tgpub',
    slug: 'voronka',
    content: 'post-2',
  });
  assert.deepEqual(parseCallback('tgdrop:voronka'), { action: 'tgdrop', slug: 'voronka', content: '' });
  assert.deepEqual(parseCallback('evil:voronka'), { action: 'unknown', slug: 'voronka', content: '' });
  assert.deepEqual(parseCallback('tgpub:../../x'), { action: 'unknown', slug: '', content: '' });
  assert.deepEqual(parseCallback(''), { action: 'unknown', slug: '', content: '' });
});

test('escapeHtml: кавычки не ломают атрибут ссылки', () => {
  assert.equal(escapeHtml('a "b" & c'), 'a &quot;b&quot; &amp; c');
});

/* ── Картинка в посте (17.11.2026) ───────────────────────────────────── */

test('isPhotoUrl: пропускает https и http, отсекает остальное', () => {
  assert.equal(isPhotoUrl('https://ai-traffic-pro.ru/blog/test.jpg'), true);
  assert.equal(isPhotoUrl('http://example.com/a.png'), true);

  for (const bad of ['', 'blog/test.jpg', '/blog/test.jpg', 'data:image/png;base64,AAA', 'ftp://x/y.png', 'javascript:alert(1)']) {
    assert.equal(isPhotoUrl(bad), false, `должно быть отсечено: ${bad}`);
  }
});

test('isPhotoUrl: слишком длинный адрес не пропускается', () => {
  assert.equal(isPhotoUrl(`https://x.ru/${'a'.repeat(600)}`), false);
});

test('CAPTION_LIMIT меньше лимита сообщения: подпись к фото короче', () => {
  assert.ok(CAPTION_LIMIT < POST_LIMIT);
  assert.equal(CAPTION_LIMIT, 1024);
});


/* ── Переносы строк: пост не должен превращаться в столбик ───────────────── */

test('reflow: жёсткие переносы внутри абзаца склеиваются в одну строку', () => {
  const src = 'Канал выбирают не по «где сидит аудитория»,\nа по трём проверкам.\nПервая — есть ли там люди с деньгами.\n\nВторой абзац.';
  assert.equal(
    reflow(src),
    'Канал выбирают не по «где сидит аудитория», а по трём проверкам. Первая — есть ли там люди с деньгами.\n\nВторой абзац.',
  );
});

test('reflow: пункты списка остаются пунктами, хвост приклеивается к своему', () => {
  const src = 'Чинить в этом порядке:\n1. одна точка входа\nдля всех каналов;\n2. срок ответа;\n3. следующий шаг.';
  assert.equal(
    reflow(src),
    'Чинить в этом порядке:\n1. одна точка входа для всех каналов;\n2. срок ответа;\n3. следующий шаг.',
  );
});

test('renderPost: абзац с переносами не превращается в столбик', () => {
  const html = renderPost('Первая строка поста,\nвторая строка того же абзаца.', 'https://ai-traffic-pro.ru/blog/test/');
  assert.equal(html, 'Первая строка поста, вторая строка того же абзаца.');
});

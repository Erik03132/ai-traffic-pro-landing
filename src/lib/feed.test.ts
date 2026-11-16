import assert from 'node:assert/strict';
import test from 'node:test';

import type { Article } from '../data/types.ts';
import {
  absolutizeLinks,
  articleUrl,
  buildRss,
  cdata,
  escapeXml,
  renderArticleHtml,
  rfc822,
} from './feed.ts';

const SITE = 'https://ai-traffic-pro.ru';

const article = (patch: Partial<Article> = {}): Article => ({
  slug: 'test-article',
  service: 'seo',
  title: 'Тестовая статья',
  seoTitle: 'Тестовая статья — SEO',
  seoDescription: 'Короткое описание для ленты.',
  lead: 'Лид статьи.',
  date: '2026-11-16',
  readingTime: 7,
  tag: 'SEO',
  image: '/blog/test-article.jpg',
  sections: [],
  faq: [],
  ...patch,
});

test('escapeXml: спецсимволы не ломают XML и атрибуты', () => {
  assert.equal(escapeXml('a & b < c > d "e" \'f\''), 'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
});

test('cdata: разрывает запрещённую последовательность ]]>', () => {
  const wrapped = cdata('до ]]> после');
  assert.ok(wrapped.startsWith('<![CDATA['));
  assert.ok(wrapped.endsWith(']]>'));
  // Последовательность разорвана на две секции — иначе XML невалиден.
  assert.ok(wrapped.includes(']]]]><![CDATA[>'));
});

test('absolutizeLinks: относительные href и src становятся абсолютными', () => {
  const html = '<a href="/services/seo/">SEO</a><img src="/blog/x.jpg"><a href="#top">top</a>';
  assert.equal(
    absolutizeLinks(html, SITE),
    `<a href="${SITE}/services/seo/">SEO</a><img src="${SITE}/blog/x.jpg"><a href="#top">top</a>`,
  );
});

test('absolutizeLinks: слэш на конце siteUrl не даёт двойного слэша', () => {
  assert.equal(absolutizeLinks('<a href="/blog/">x</a>', `${SITE}/`), `<a href="${SITE}/blog/">x</a>`);
});

test('articleUrl: канонический адрес со слэшем на конце', () => {
  assert.equal(articleUrl(SITE, 'abc'), `${SITE}/blog/abc/`);
});

test('rfc822: дата статьи публикуется в 09:00 по Москве', () => {
  assert.equal(rfc822('2026-11-16'), 'Mon, 16 Nov 2026 06:00:00 GMT');
});

test('rfc822: битая дата не роняет сборку', () => {
  assert.equal(rfc822('не дата'), new Date(0).toUTCString());
});

test('renderArticleHtml: текст, подразделы, таблица, FAQ и источники попадают в ленту', () => {
  const html = renderArticleHtml(
    article({
      sections: [
        {
          title: 'Раздел',
          paragraphs: ['Абзац со <a href="/services/seo/">ссылкой</a>.'],
          list: ['Пункт'],
          steps: ['Шаг'],
          sub: [{ title: 'Подраздел', paragraphs: ['Текст'], list: ['Подпункт'] }],
          table: { head: ['A', 'B'], rows: [['1', '2']] },
        },
      ],
      faq: [{ q: 'Вопрос?', a: 'Ответ.' }],
      sources: [{ label: 'Источник', url: 'https://example.com/src' }],
    }),
    SITE,
  );

  assert.match(html, /<figure><img src="https:\/\/ai-traffic-pro\.ru\/blog\/test-article\.jpg"/);
  assert.match(html, /<p>Лид статьи\.<\/p>/);
  assert.match(html, /<h2>Раздел<\/h2>/);
  assert.match(html, new RegExp(`<a href="${SITE}/services/seo/">ссылкой</a>`));
  assert.match(html, /<ul><li>Пункт<\/li><\/ul>/);
  assert.match(html, /<ol><li>Шаг<\/li><\/ol>/);
  assert.match(html, /<h3>Подраздел<\/h3>/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><td>2<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<h3>Вопрос\?<\/h3><p>Ответ\.<\/p>/);
  assert.match(html, /<a href="https:\/\/example\.com\/src">Источник<\/a>/);
});

test('buildRss: лента валидна по структуре и содержит все статьи', () => {
  const older = article({ slug: 'older', date: '2026-11-01' });
  const newer = article({ slug: 'newer', date: '2026-11-16' });

  const xml = buildRss({ articles: [older, newer], siteUrl: SITE, title: 'Блог', description: 'Описание' });

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<rss version="2.0" xmlns:content=/);
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
  assert.ok(xml.trimEnd().endsWith('</rss>'));

  // Свежая статья выше старой.
  assert.ok(xml.indexOf('newer') < xml.indexOf('older'));
  // Ссылки и guid канонические, с utm не смешиваются.
  assert.match(xml, new RegExp(`<guid isPermaLink="true">${SITE}/blog/newer/</guid>`));
  // Обложка абсолютная — Telegram и Дзен сами скачивают файл по ссылке.
  assert.match(xml, new RegExp(`<enclosure url="${SITE}/blog/test-article\\.jpg" type="image/jpeg"`));
  // Полный текст внутри CDATA, а не экранированный.
  assert.match(xml, /<content:encoded><!\[CDATA\[/);
  assert.match(xml, /<content:encoded><!\[CDATA\[(?:.|\n)*<p>Лид статьи\.<\/p>/);
});

test('buildRss: lastBuildDate — дата свежей статьи, а не момент сборки', () => {
  const xml = buildRss({
    articles: [article({ date: '2026-11-01' }), article({ slug: 'b', date: '2026-11-16' })],
    siteUrl: SITE,
    title: 'Блог',
    description: 'Описание',
  });
  assert.match(xml, /<lastBuildDate>Mon, 16 Nov 2026 06:00:00 GMT<\/lastBuildDate>/);
});

test('buildRss: limit отрезает хвост, а не голову', () => {
  const articles = [
    article({ slug: 'a', date: '2026-11-01' }),
    article({ slug: 'b', date: '2026-11-02' }),
    article({ slug: 'c', date: '2026-11-03' }),
  ];
  const xml = buildRss({ articles, siteUrl: SITE, title: 'Блог', description: 'Описание', limit: 2 });
  assert.equal((xml.match(/<item>/g) ?? []).length, 2);
  assert.match(xml, /\/blog\/c\//);
  assert.match(xml, /\/blog\/b\//);
  assert.doesNotMatch(xml, /\/blog\/a\//);
});

test('buildRss: categories добавляются к каждой публикации (нужно Дзену)', () => {
  const xml = buildRss({
    articles: [article()],
    siteUrl: SITE,
    title: 'Блог',
    description: 'Описание',
    categories: ['native-draft'],
  });
  assert.match(xml, /<category>native-draft<\/category>/);
  assert.match(xml, /<category>SEO<\/category>/);
});

test('buildRss: статья без обложки не ломает ленту', () => {
  const xml = buildRss({
    articles: [article({ image: undefined })],
    siteUrl: SITE,
    title: 'Блог',
    description: 'Описание',
  });
  assert.doesNotMatch(xml, /<enclosure/);
  assert.match(xml, /<item>/);
});

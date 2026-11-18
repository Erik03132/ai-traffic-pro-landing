/**
 * RSS-лента блога: сборка XML из тех же данных, что и страницы.
 *
 * Зачем отдельный модуль, а не endpoint «в одну строку»: лента уезжает на
 * чужие площадки (Дзен, Яндекс, агрегаторы, ридеры), и ошибка в ней видна не
 * у нас, а там — в виде пустого превью или отклонённой ленты. Поэтому:
 *
 * - сборка — чистые функции, их проверяет `feed.test.ts`;
 * - никаких импортов из `site.ts`: внутри `import.meta.env`, и модуль
 *   перестал бы запускаться под `node --test`;
 * - даты и `lastBuildDate` берутся из данных статьи, а не из момента сборки —
 *   пересборка сайта не должна «обновлять» все посты в чужой ленте.
 *
 * Требования Дзена (см. ADR-005): RSS 2.0, `content:encoded` с полным текстом,
 * `enclosure` с обложкой, стабильный `guid`, `pubDate`. Соблюдаем сразу, даже
 * пока лента используется только читалками: разметку потом не переделывать.
 */
import type { Article } from '../data/types';

export interface FeedOptions {
  articles: Article[];
  /** Канон сайта без слэша на конце: `https://ai-traffic-pro.ru`. */
  siteUrl: string;
  title: string;
  description: string;
  language?: string;
  /**
   * Дополнительные `<category>` для каждой публикации.
   * Дзен читает их как команды: `native-draft` — черновик в Студии вместо
   * мгновенной публикации (пригодится на этапе 5, ADR-005).
   */
  categories?: string[];
  /** Сколько последних статей отдавать. Лента — витрина, а не архив. */
  limit?: number;
  /** Почта автора для `managingEditor` (необязательно). */
  authorEmail?: string;
}

/**
 * Сколько статей в ленте по умолчанию.
 *
 * Полный текст одной статьи — 20–25 КБ XML, поэтому лента не должна расти
 * бесконечно: 20 материалов ≈ 500 КБ, это ещё быстро для площадок. Дзен при
 * первой разметке требует минимум 10 — запас есть.
 */
const DEFAULT_LIMIT = 20;

/** Час публикации по Москве: дата в данных без времени, ленте нужно время. */
const MSK_OFFSET = '+03:00';

/** Минимальная ширина обложки, которую принимает Дзен. */
export const MIN_COVER_WIDTH = 700;

/**
 * Экранирование текста для XML.
 *
 * Кавычки тоже экранируются: значения попадают в атрибуты (`<enclosure url="…">`),
 * а `&` и `<` — в текстовые узлы. Одна функция на оба случая безопаснее двух.
 */
export function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Оборачивает HTML в CDATA.
 *
 * Внутри `content:encoded` нужен живой HTML, а не экранированный: иначе
 * читалка покажет теги текстом. `]]>` внутри CDATA запрещён — разрываем его
 * на две секции.
 */
export function cdata(html: string): string {
  return `<![CDATA[${String(html).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** Абсолютный адрес статьи. Слэш на конце — как у сайта (`trailingSlash: 'always'`). */
export function articleUrl(siteUrl: string, slug: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/blog/${slug}/`;
}

/**
 * Делает относительные ссылки в тексте статьи абсолютными.
 *
 * В статьях есть `<a href="/services/seo/">`: на сайте это работает, в чужой
 * ленте ведёт в никуда. Правим и `href`, и `src`.
 */
export function absolutizeLinks(html: string, siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  return html.replace(/(href|src)="(\/(?!\/)[^"]*)"/g, (_m, attr: string, path: string) => `${attr}="${base}${path}"`);
}

/** Дата статьи в формате RFC 822 (требование RSS). */
export function rfc822(date: string): string {
  const parsed = new Date(`${date}T09:00:00${MSK_OFFSET}`);
  // Некорректная дата в данных не должна ломать сборку: отдаём эпоху и
  // роняем тест, а не страницу.
  if (Number.isNaN(parsed.getTime())) return new Date(0).toUTCString();
  return parsed.toUTCString();
}

/** Полный текст статьи как HTML — то, что увидит читалка и Дзен. */
export function renderArticleHtml(article: Article, siteUrl: string): string {
  const base = siteUrl.replace(/\/+$/, '');
  const parts: string[] = [];

  if (article.image) {
    parts.push(
      `<figure><img src="${escapeXml(`${base}${article.image}`)}" alt="${escapeXml(article.title)}"></figure>`,
    );
  }

  parts.push(`<p>${article.lead}</p>`);

  for (const section of article.sections) {
    parts.push(`<h2>${section.title}</h2>`);

    for (const paragraph of section.paragraphs ?? []) parts.push(`<p>${paragraph}</p>`);

    if (section.list?.length) {
      parts.push(`<ul>${section.list.map((item) => `<li>${item}</li>`).join('')}</ul>`);
    }

    if (section.steps?.length) {
      parts.push(`<ol>${section.steps.map((item) => `<li>${item}</li>`).join('')}</ol>`);
    }

    for (const sub of section.sub ?? []) {
      parts.push(`<h3>${sub.title}</h3>`);
      for (const paragraph of sub.paragraphs ?? []) parts.push(`<p>${paragraph}</p>`);
      if (sub.list?.length) {
        parts.push(`<ul>${sub.list.map((item) => `<li>${item}</li>`).join('')}</ul>`);
      }
    }

    if (section.table) {
      const head = section.table.head.map((cell) => `<th>${cell}</th>`).join('');
      const rows = section.table.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
        .join('');
      parts.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`);
    }
  }

  if (article.faq.length) {
    parts.push('<h2>Вопросы по теме</h2>');
    for (const item of article.faq) {
      parts.push(`<h3>${item.q}</h3><p>${item.a}</p>`);
    }
  }

  if (article.sources?.length) {
    parts.push('<h2>Источники</h2>');
    parts.push(
      `<ul>${article.sources
        .map((source) => `<li><a href="${source.url}">${source.label}</a></li>`)
        .join('')}</ul>`,
    );
  }

  return absolutizeLinks(parts.join('\n'), siteUrl);
}

/** Собирает один `<item>`. */
function renderItem(article: Article, opts: FeedOptions): string {
  const url = articleUrl(opts.siteUrl, article.slug);
  const categories = [
    ...(opts.categories ?? []),
    ...(article.tag ? [article.tag] : []),
  ]
    .map((category) => `    <category>${escapeXml(category)}</category>`)
    .join('\n');

  const lines = [
    '  <item>',
    `    <title>${escapeXml(article.title)}</title>`,
    `    <link>${escapeXml(url)}</link>`,
    // guid = канонический адрес: площадка узнаёт переизданную статью по нему,
    // а не по новой дате сборки.
    `    <guid isPermaLink="true">${escapeXml(url)}</guid>`,
    `    <pubDate>${rfc822(article.date)}</pubDate>`,
    categories,
  ];

  if (article.author?.name) {
    lines.push(`    <dc:creator>${escapeXml(article.author.name)}</dc:creator>`);
  }

  lines.push(`    <description>${escapeXml(article.seoDescription || article.lead)}</description>`);

  if (article.image) {
    const image = `${opts.siteUrl.replace(/\/+$/, '')}${article.image}`;
    // length неизвестен без обращения к файлу, а 0 площадки принимают.
    lines.push(`    <enclosure url="${escapeXml(image)}" type="image/jpeg" length="0"/>`);
  }

  lines.push(`    <content:encoded>${cdata(renderArticleHtml(article, opts.siteUrl))}</content:encoded>`);
  lines.push('  </item>');

  return lines.filter(Boolean).join('\n');
}

/**
 * Собирает всю ленту.
 *
 * Порядок — от свежих к старым, `lastBuildDate` — дата самой свежей статьи:
 * пересборка сайта не должна выглядеть как «вышло 11 новых постов».
 */
export function buildRss(opts: FeedOptions): string {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const articles = [...opts.articles]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.slug.localeCompare(b.slug)))
    .slice(0, Math.max(1, limit));

  const siteUrl = opts.siteUrl.replace(/\/+$/, '');
  const feedUrl = `${siteUrl}/rss.xml`;
  const lastBuildDate = articles.length ? rfc822(articles[0].date) : new Date(0).toUTCString();

  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(opts.title)}</title>`,
    `    <link>${escapeXml(siteUrl)}/</link>`,
    `    <description>${escapeXml(opts.description)}</description>`,
    `    <language>${escapeXml(opts.language ?? 'ru-RU')}</language>`,
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    '    <generator>AI-TRAFFIC-PRO</generator>',
    `    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>`,
  ];

  if (opts.authorEmail) {
    head.push(`    <managingEditor>${escapeXml(opts.authorEmail)}</managingEditor>`);
  }

  const body = articles.map((article) => renderItem(article, opts));

  return [...head, ...body, '  </channel>', '</rss>', ''].join('\n');
}

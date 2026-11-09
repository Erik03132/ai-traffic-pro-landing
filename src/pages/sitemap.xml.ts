/**
 * Карта сайта — свой endpoint вместо плагина @astrojs/sitemap.
 *
 * Почему свой: плагин генерирует `sitemap-index.xml` + `sitemap-0.xml`,
 * а robots.txt и `<link rel="sitemap">` указывают на `/sitemap.xml` —
 * поисковик получал бы 404. Свой endpoint решает это и даёт контроль
 * над составом карты: список URL собирается из единого источника истины.
 *
 * В карту попадают только страницы, которые должны индексироваться:
 * главная + все страницы услуг + реквизиты для оплаты + политика
 * конфиденциальности. Согласие на обработку данных (`/consent/`) остаётся
 * вне карты: это приложение к политике, самостоятельной ценности в поиске нет
 * (страница по-прежнему отдаёт `noindex`).
 *
 * `lastmod` — реальная дата последнего изменения содержимого страницы
 * (задача 1.4). До 09.11.2026 все URL несли дату сборки, то есть одну и ту же
 * дату: Google не мог отличить свежую статью от страницы, не менявшейся
 * месяц. Данные берутся из поля `lastmod` источников истины (`date` у статей,
 * `lastmod` у услуг), а не из времени сборки.
 */
import type { APIRoute } from 'astro';
import { ALL_SERVICES, SITE_URL } from '../data/site';
import { ARTICLES } from '../data/blog';

/** Дата последнего изменения содержимого страницы (ISO, YYYY-MM-DD). */
interface Lastmod {
  path: string;
  lastmod: string;
  priority: string;
  changefreq: string;
}

/**
 * Даты правок фиксируются в данных, а не вычисляются: сборка может идти
 * в любой день, и «дата последнего изменения» должна отражать содержание,
 * а не момент запуска `npm run build`.
 */
const CONTENT_LASTMOD: Record<string, string> = {
  // Главная и разделы — правки 09.11.2026 (мобильная вёрстка, плотность).
  '/': '2026-11-09',
  '/blog/': '2026-11-09',
  '/requisites/': '2026-11-09',
  '/privacy/': '2026-11-09',
};

const SERVICE_LASTMOD: Record<string, string> = {
  '/services/leadgen/': '2026-11-04',
  '/services/seo/': '2026-11-04',
  '/services/smm/': '2026-11-04',
  '/services/advertising/': '2026-11-04',
  '/services/landing/': '2026-11-04',
  '/services/crm/': '2026-11-04',
  '/services/ecommerce/': '2026-11-04',
};

/**
 * Приоритет: главная выше, услуги равны между собой, правовые страницы ниже.
 * Блог и статьи — по умолчанию 0.6.
 */
const buildEntries = (): Lastmod[] => {
  const entries: Lastmod[] = [];

  for (const [path, lastmod] of Object.entries(CONTENT_LASTMOD)) {
    entries.push({
      path,
      lastmod,
      priority: path === '/' ? '1.0' : path === '/requisites/' || path === '/privacy/' ? '0.3' : '0.6',
      changefreq: path === '/' ? 'weekly' : 'monthly',
    });
  }

  for (const [path, lastmod] of Object.entries(SERVICE_LASTMOD)) {
    entries.push({ path, lastmod, priority: '0.8', changefreq: 'monthly' });
  }

  for (const article of ARTICLES) {
    entries.push({
      path: `/blog/${article.slug}/`,
      // Дата публикации статьи: она и есть дата последнего изменения текста.
      lastmod: article.date,
      priority: '0.6',
      changefreq: 'monthly',
    });
  }

  return entries;
};

export const GET: APIRoute = () => {
  const entries = buildEntries();

  const urls = entries
    .map(
      (e) => `  <url>
    <loc>${new URL(e.path, SITE_URL).toString()}</loc>
    <lastmod>${e.lastmod}</lastmod>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};

/**
 * Карта сайта — свой endpoint вместо плагина @astrojs/sitemap.
 *
 * Почему свой: плагин генерирует `sitemap-index.xml` + `sitemap-0.xml`,
 * а robots.txt и `<link rel="sitemap">` указывают на `/sitemap.xml` —
 * поисковик получал бы 404. Свой endpoint решает это и даёт контроль
 * над составом карты: список URL собирается из единого источника истины.
 *
 * В карту попадают только страницы, которые должны индексироваться:
 * главная + все страницы услуг + реквизиты для оплаты. Правовые документы —
 * черновики (noindex) и вне карты.
 */
import type { APIRoute } from 'astro';
import { ALL_SERVICES, SITE_URL } from '../data/site';
import { ARTICLES } from '../data/blog';

/** Страницы, которые индексируются. Правовые документы исключены осознанно. */
const INDEXABLE_PATHS: string[] = [
  '/',
  '/requisites/',
  '/blog/',
  ...ALL_SERVICES.map((s) => `/services/${s.slug}/`),
  ...ARTICLES.map((a) => `/blog/${a.slug}/`),
];

export const GET: APIRoute = () => {
  const today = new Date().toISOString().slice(0, 10);

  const urls = INDEXABLE_PATHS.map((path) => {
    const loc = new URL(path, SITE_URL).toString();
    // Приоритет: главная выше, услуги равны между собой, реквизиты — ниже.
    const priority =
      path === '/'
        ? '1.0'
        : path === '/requisites/'
          ? '0.3'
          : path.startsWith('/blog/') && path !== '/blog/'
            ? '0.6'
            : '0.8';
    return `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${path === '/' ? 'weekly' : 'monthly'}</changefreq>
    <priority>${priority}</priority>
  </url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};

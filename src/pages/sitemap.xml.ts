/**
 * Карта сайта — свой endpoint вместо плагина @astrojs/sitemap.
 *
 * Почему свой: плагин генерирует `sitemap-index.xml` + `sitemap-0.xml`,
 * а robots.txt и `<link rel="sitemap">` указывают на `/sitemap.xml` —
 * поисковик получал бы 404. Свой endpoint решает это и даёт контроль
 * над составом карты: список URL собирается из единого источника истины.
 *
 * В карту попадают только страницы, которые должны индексироваться:
 * главная + шесть услуг. Правовые документы — черновики (noindex),
 * маркетплейс — дополнительное направление вне основной карты.
 */
import type { APIRoute } from 'astro';
import { SERVICES, SITE_URL } from '../data/site';

/** Страницы, которые индексируются. Правовые и маркетплейс исключены осознанно. */
const INDEXABLE_PATHS: string[] = ['/', ...SERVICES.map((s) => `/services/${s.slug}/`)];

export const GET: APIRoute = () => {
  const today = new Date().toISOString().slice(0, 10);

  const urls = INDEXABLE_PATHS.map((path) => {
    const loc = new URL(path, SITE_URL).toString();
    // Приоритет: главная выше, услуги равны между собой.
    const priority = path === '/' ? '1.0' : '0.8';
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

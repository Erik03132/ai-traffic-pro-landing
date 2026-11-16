/**
 * `/rss.xml` — лента блога с полным текстом.
 *
 * Один endpoint на все площадки (ADR-005): читалки, агрегаторы, а на этапе 5 —
 * Дзен, который вообще не имеет API публикации и принимает только RSS.
 * Отдельная лента для Дзена не нужна: разметка (`content:encoded`,
 * `enclosure`, `guid`) общая, различаться будут только `<category>`, и они
 * добавляются параметром билдера.
 *
 * Почему свой endpoint, а не плагин: та же причина, что у `sitemap.xml` —
 * контроль над составом и адресом. Плагины любят отдавать ленту без полного
 * текста, а Дзену нужен именно текст.
 */
import type { APIRoute } from 'astro';

import { ARTICLES } from '../data/blog';
import { SITE, SITE_URL } from '../data/site';
import { buildRss } from '../lib/feed';

export const GET: APIRoute = () => {
  const xml = buildRss({
    articles: ARTICLES,
    siteUrl: SITE_URL,
    title: `${SITE.name} — блог`,
    description: `Статьи о привлечении клиентов: реклама, SEO, контент и аналитика без обещаний «×10 за неделю».`,
    authorEmail: SITE.legal.email || undefined,
  });

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};

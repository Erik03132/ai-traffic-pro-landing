/**
 * `/distribution/manifest.json` — очередь публикаций для cron Worker.
 *
 * Зачем отдельный файл: у Worker нет доступа к git, а тексты постов живут
 * в репозитории. Манифест собирается на билде из `docs/distribution/registry.json`
 * и файлов `docs/distribution/posts/*.md`, поэтому источник истины остаётся
 * один (git), а Worker получает готовый снимок очереди одним HTTP-запросом
 * раз в сутки. Копий текстов в KV не появляется — это важнее, чем кажется:
 * копия расходится с оригиналом молча.
 *
 * Здесь только данные, пригодные к публикации: текст без служебной шапки,
 * дата, канал, обложка. Решение «что пора» принимает Worker (`duePublications`
 * в `worker/src/publish.js`) — дата и часовой пояс считаются там, где известен
 * момент запуска, а не момент сборки.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { APIRoute } from 'astro';

import registry from '../../../docs/distribution/registry.json';
import { SITE_URL } from '../../data/site';

/** Служебная шапка поста отделена строкой `---`; в манифест она не идёт. */
function postText(slug: string, post: string): string | null {
  const file = path.join(process.cwd(), 'docs', 'distribution', 'posts', `${slug}.${post}.md`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const marker = raw.indexOf('\n---\n');
  return (marker === -1 ? raw : raw.slice(marker + 5)).trim();
}

/**
 * Обложка статьи: она же превью ссылки и картинка поста.
 *
 * Ищем те же имена, что реально лежат в `public/blog/`: `-cover.png` (основной
 * размер) и `.jpg` (старые статьи). Раньше проверялся только `.jpg`, поэтому
 * cron отправлял посты без обложки — файл лежал рядом, но под другим именем.
 */
function coverUrl(slug: string): string | null {
  for (const name of [`${slug}-cover.png`, `${slug}.jpg`, `${slug}-cover.jpg`]) {
    if (fs.existsSync(path.join(process.cwd(), 'public', 'blog', name))) {
      return `${SITE_URL}/blog/${name}`;
    }
  }
  return null;
}

interface RegistryEntry {
  id: string;
  slug: string;
  post: string;
  channel: string;
  status: string;
  plannedAt: string | null;
}

export const GET: APIRoute = () => {
  const entries = (registry as { publications?: RegistryEntry[] }).publications ?? [];

  const publications = entries.map((entry) => ({
    id: entry.id,
    slug: entry.slug,
    post: entry.post,
    channel: entry.channel,
    status: entry.status,
    plannedAt: entry.plannedAt ?? null,
    text: postText(entry.slug, entry.post),
    photo: coverUrl(entry.slug),
  }));

  return new Response(JSON.stringify({ version: 1, publications }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      // Файл служебный: поисковику он не нужен, а cron читает его напрямую.
      'X-Robots-Tag': 'noindex',
    },
  });
};

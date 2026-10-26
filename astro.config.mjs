// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

/**
 * AI-Traffic PRO — конфигурация сборки.
 *
 * Единый источник истины по контенту — `src/data/site.ts` (SITE_URL, услуги, тексты).
 * Этот файл знает только про инфраструктуру: домен, интеграции, адаптер.
 */
export default defineConfig({
  // Канон сайта. Используется для canonical, sitemap, robots, JSON-LD.
  site: 'https://ai-traffic-pro.ru',
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    sitemap({
      // В sitemap — только то, что должно индексироваться и продвигаться.
      // Правовые документы — черновики (noindex), маркетплейс — доп. направление
      // вне шести карточек, доступен по прямой ссылке.
      filter: (page) => {
        const excluded = ['/privacy/', '/consent/', '/services/marketplace/'];
        return !excluded.some((path) => page.endsWith(path));
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    server: {
      port: 4321,
      // В dev-режиме API лидов и чат-бота проксируются на локальный сервер заявок.
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    },
  },
});

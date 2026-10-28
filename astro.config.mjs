// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

/**
 * AI-Traffic PRO — конфигурация сборки.
 *
 * Единый источник истины по контенту — `src/data/site.ts` (SITE_URL, услуги, тексты).
 * Этот файл знает только про инфраструктуру: домен, интеграции, адаптер.
 *
 * Карта сайта — собственный endpoint `src/pages/sitemap.xml.ts`:
 * он отдаёт ровно `/sitemap.xml`, на который ссылаются robots.txt и
 * `<link rel="sitemap">`. Плагин @astrojs/sitemap давал `sitemap-index.xml`,
 * на который эти ссылки вели в 404.
 */
export default defineConfig({
  // Канон сайта. Используется для canonical, sitemap, robots, JSON-LD.
  site: 'https://ai-traffic-pro.ru',
  output: 'static',
  trailingSlash: 'always',
  integrations: [],
  /**
   * Редиректы старых адресов.
   *
   * Прод отдаёт GitHub Pages (DNS A → 185.199.108.153), а nginx на VPS
   * обслуживает только API-поддомен, поэтому 301 на уровне сервера недоступен.
   * Astro генерирует для этих путей статическую страницу с meta-refresh —
   * рабочий вариант для статического хостинга.
   *
   * 28.10.2026: маркетплейс поглощён услугой e-commerce (/services/ecommerce/).
   */
  redirects: {
    '/services/marketplace/': '/services/ecommerce/',
  },
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

/**
 * Тесты публичного AI-аудита.
 *
 * Запуск: node --test worker/src/audit.test.js
 *
 * Главный тест — паритет с внутренним линтером. `tools/geo_lint.py` остаётся
 * источником истины, а `audit.js` — его порт в Worker. Если веса или правила
 * разъедутся, публичный аудит начнёт обещать клиенту не то, что показывает
 * внутренняя приёмка. Эталон посчитан командой:
 *
 *   python3 tools/geo_lint.py --file worker/src/__fixtures__/article.html
 *   → 98/100, 1272 слова, ответ через 90 слов, таблиц 1, H2/H3 4/8
 *
 * Второй блок — безопасность: аудит принимает произвольный URL от клиента,
 * поэтому проверки на внутренние адреса обязательны (SSRF).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AuditError, analyze, auditUrl, checkSite, parsePage, safeUrl } from './audit.js';

const FIXTURE = readFileSync(new URL('./__fixtures__/article.html', import.meta.url), 'utf8');

test('паритет с geo_lint.py на эталонной статье', () => {
  const r = analyze(FIXTURE, { url: 'https://example.com/blog/crm-i-erp/', query: 'crm и erp разница' });

  assert.equal(r.score, 98);
  const byKey = Object.fromEntries(r.blocks.map((b) => [b.key, b.score]));
  assert.deepEqual(byKey, {
    answer: 12,
    depth: 8,
    table: 14,
    numbers: 14,
    entities: 14,
    sources: 10,
    structure: 12,
    schema: 14,
  });

  assert.equal(r.metrics.words, 1272);
  assert.equal(r.metrics.words_before_first_h2, 90);
  assert.equal(r.metrics.tables, 1);
  assert.equal(r.metrics.h2, 4);
  assert.equal(r.metrics.h3, 8);
  assert.equal(r.metrics.comparative, true);
  assert.deepEqual(r.metrics.entities, ['1с', 'amocrm', 'odoo', 'sap', 'битрикс', 'битрикс24']);
  assert.equal(r.meta.has_blogposting, true);
  assert.equal(r.meta.has_faqpage, true);
  assert.equal(r.meta.has_person, true);
});

test('пустая страница даёт 0 и список правок, а не падение', () => {
  const r = analyze('<html><body><p>Привет</p></body></html>', { url: 'https://example.com/' });

  assert.equal(r.score, 0);
  assert.equal(r.metrics.words, 1);
  assert.ok(r.fixes.length >= 8, `ожидали полный список правок, получили ${r.fixes.length}`);
  assert.ok(r.fixes.some((f) => f.includes('table')));
});

test('внутренние ссылки считаются по origin проверяемого сайта, а не по нашему домену', () => {
  const html = `<main><article><h1>Т</h1><p>Текст про Битрикс24, 30 дней, 15 процентов.</p>
    <p><a href="https://client.ru/services/seo/">услуга</a>
    <a href="/blog/post/">пост</a>
    <a href="https://habr.com/ru/articles/1/">источник</a>
    <a href="https://habr.com/ru/articles/2/">источник 2</a></p></article></main>`;
  const r = analyze(html, { url: 'https://client.ru/page/' });

  assert.equal(r.metrics.internal_links, 2);
  assert.equal(r.metrics.external_links, 2);
});

test('соцсети не считаются первоисточниками, но официальная справка — да', () => {
  const html = `<article><h1>Т</h1><p>Текст.</p>
    <p><a href="https://t.me/channel">телеграм</a>
    <a href="https://vk.com/club1">вк</a>
    <a href="https://platform.example.com/docs/setup">документация</a></p></article>`;
  const r = analyze(html, { url: 'https://example.com/' });

  assert.equal(r.metrics.external_links, 1);
});

test('SSRF: приватные и локальные адреса отклоняются', () => {
  const blocked = [
    'http://localhost/',
    'https://127.0.0.1/',
    'http://10.0.0.5:8080/',
    'http://192.168.1.1/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://metadata.google.internal/',
    'http://router.local/',
    'http://intranet/',
  ];
  for (const url of blocked) {
    assert.throws(() => safeUrl(url), AuditError, `должен блокироваться: ${url}`);
  }
});

test('SSRF: публичные адреса проходят и нормализуются', () => {
  assert.equal(safeUrl('example.com').href, 'https://example.com/');
  assert.equal(safeUrl('https://example.com/page#anchor').href, 'https://example.com/page');
  assert.equal(safeUrl('http://example.com/').protocol, 'http:');
});

test('SSRF: не-http схемы и адреса с паролем отклоняются', () => {
  assert.throws(() => safeUrl('javascript:alert(1)'), AuditError);
  assert.throws(() => safeUrl('file:///etc/passwd'), AuditError);
  assert.throws(() => safeUrl('https://user:pass@example.com/'), AuditError);
  assert.throws(() => safeUrl(''), AuditError);
});

test('разбор страницы: заголовки, таблицы, JSON-LD и текст внутри article', () => {
  const p = parsePage(FIXTURE);
  assert.equal(p.title, 'Сравнение CRM и ERP: что выбрать в 2026 году');
  assert.equal(p.tables, 1);
  assert.equal(p.ldjson.length, 2);
  assert.equal(p.headings.filter((h) => h.level === 2).length, 4);
  assert.ok(p.textRegion.includes('Срок внедрения 45 дней'));
  assert.ok(!p.textRegion.includes('schema.org'), 'JSON-LD не должен попадать в текст страницы');
});

test('checkSite: читает robots/llms/sitemap и ловит запрет AI-ботов', async () => {
  const bodies = {
    'https://client.ru/robots.txt': 'User-agent: GPTBot\nDisallow: /\nSitemap: https://client.ru/sitemap.xml',
    'https://client.ru/sitemap.xml': '<urlset><url><loc>https://client.ru/</loc></url><url><loc>https://client.ru/a</loc></url></urlset>',
  };
  const site = await checkSite('https://client.ru', async (url) => {
    if (url in bodies) return bodies[url];
    throw new Error('404');
  });

  assert.equal(site.robots.found, true);
  assert.equal(site.robots.blocks_ai_bots, true);
  assert.equal(site.robots.declares_ai, true);
  assert.equal(site.sitemap.urls, 2);
  assert.equal(site.sitemap.listed_in_robots, true);
  assert.equal(site.llms.found, false);
});

test('auditUrl: собирает отчёт и подсказки по сайту без похода в сеть', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/llms.txt')) return new Response('not found', { status: 404 });
    const body =
      url.endsWith('/robots.txt')
        ? 'User-agent: *\nAllow: /\n'
        : url.endsWith('/sitemap.xml')
          ? '<urlset><url><loc>https://client.ru/</loc></url></urlset>'
          : FIXTURE;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };

  const r = await auditUrl('client.ru/blog/crm-i-erp/', { fetchImpl, query: 'crm и erp разница' });

  assert.equal(r.url, 'https://client.ru/blog/crm-i-erp/');
  assert.equal(r.score, 98);
  assert.equal(r.site.robots.found, true);
  assert.equal(r.site.llms.found, false);
  assert.ok(r.notes.some((n) => n.includes('llms.txt')));
  assert.ok(r.notes.some((n) => n.includes('sitemap.xml не объявлен')), 'sitemap без объявления в robots — повод сказать');
});

test('auditUrl: ошибка сайта превращается в понятный код, а не в 500', async () => {
  const fail = (status) => async () => new Response('nope', { status });
  await assert.rejects(() => auditUrl('https://client.ru/', { fetchImpl: fail(403) }), (err) => {
    assert.equal(err.code, 'HTTP');
    assert.match(err.message, /403/);
    return true;
  });

  const abort = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(() => auditUrl('https://client.ru/', { fetchImpl: abort }), (err) => {
    assert.equal(err.code, 'TIMEOUT');
    return true;
  });
});

test('auditUrl: не-html ответ не ломает подсчёт', async () => {
  const fetchImpl = async () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await auditUrl('https://client.ru/data.json', { fetchImpl });
  assert.equal(typeof r.score, 'number');
  assert.ok(r.score >= 0 && r.score <= 100);
});

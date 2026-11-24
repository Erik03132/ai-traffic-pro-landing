/**
 * Тесты страницы `/geo-audit/` (24.11.2026).
 *
 * Зачем: аудит продаётся тремя цифрами — цена, срок, объём замера. Если они
 * разойдутся между страницей, `Offer` в разметке и `llms.txt`, модель
 * процитирует одну, клиент прочитает другую. Тест держит их в согласии
 * с прайсом GEO-услуги и проверяет, что обещания на странице не пустые.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  GEO_AUDIT_FAQ,
  GEO_AUDIT_INCLUDES,
  GEO_AUDIT_LIMITS,
  GEO_AUDIT_OFFER,
  GEO_AUDIT_RUNS_TOTAL,
  GEO_AUDIT_STEPS,
  GEO_METRICS,
  GEO_SIGNALS,
  GEO_SYSTEMS,
} from '../data/geo-audit.ts';
import { geo } from '../data/services/geo.ts';
import { geoAuditBreadcrumbLd, geoAuditLd } from './geo-audit.ts';

const SITE_URL = 'https://ai-traffic-pro.ru';
const rur = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

test('аудит: цена — та же, что в прайсе GEO-услуги', () => {
  const audit = geo.prices?.find((p) => p.label === 'GEO-аудит');
  assert.ok(audit, 'в прайсе geo нет строки «GEO-аудит»');
  assert.equal(GEO_AUDIT_OFFER.price, audit.from);
  assert.equal(GEO_AUDIT_OFFER.currency, 'RUB');
  assert.ok(Number.isInteger(GEO_AUDIT_OFFER.price) && GEO_AUDIT_OFFER.price > 0);
});

test('аудит: объём замера сходится с формулой на странице', () => {
  // Страница обещает «5 запросов × 3 прогона × 6 систем = 90 прогонов».
  assert.equal(
    GEO_AUDIT_OFFER.queries * GEO_AUDIT_OFFER.runs * GEO_AUDIT_OFFER.systems,
    GEO_AUDIT_RUNS_TOTAL,
  );
  assert.equal(GEO_AUDIT_RUNS_TOTAL, 90);
  assert.equal(GEO_AUDIT_OFFER.days, 5);
  assert.equal(GEO_SYSTEMS.length, GEO_AUDIT_OFFER.systems);
});

test('Offer аудита: разовая работа с ценой из прайса', () => {
  const ld = geoAuditLd(SITE_URL);
  assert.equal(ld['@type'], 'Service');
  assert.equal(ld.offers.price, GEO_AUDIT_OFFER.price);
  assert.equal(ld.offers.priceCurrency, 'RUB');
  assert.equal(ld.offers.priceSpecification.unitText, 'разово');
  assert.equal(ld.offers.priceSpecification.price, ld.offers.price);
  assert.equal(ld.provider['@id'], `${SITE_URL}/#organization`);
  assert.equal(ld.offers.seller['@id'], `${SITE_URL}/#organization`);
});

test('крошки: главная → GEO-аудит, ссылки абсолютные', () => {
  const ld = geoAuditBreadcrumbLd(SITE_URL);
  assert.equal(ld.itemListElement.length, 2);
  for (const item of ld.itemListElement) {
    assert.ok(item.item.startsWith(SITE_URL), `относительный адрес в крошках: ${item.item}`);
  }
  const method = geoAuditBreadcrumbLd(SITE_URL, { name: 'Методика', path: '/geo-audit/methodology/' });
  assert.equal(method.itemListElement.at(-1)?.item, `${SITE_URL}/geo-audit/methodology/`);
});

test('шесть сигналов: заполнены и не повторяются', () => {
  assert.equal(GEO_SIGNALS.length, 6);
  const nums = new Set(GEO_SIGNALS.map((s) => s.num));
  assert.equal(nums.size, 6, 'номера сигналов повторяются');
  for (const s of GEO_SIGNALS) {
    for (const field of ['title', 'what', 'why', 'fail'] as const) {
      assert.ok(s[field].trim().length > 10, `${s.num}: пустое поле ${field}`);
    }
  }
});

test('FAQ: ответы содержательные, вопросы не повторяются', () => {
  assert.ok(GEO_AUDIT_FAQ.length >= 6, 'меньше шести вопросов — страница тонкая для цитирования');
  const questions = new Set(GEO_AUDIT_FAQ.map((f) => f.q));
  assert.equal(questions.size, GEO_AUDIT_FAQ.length, 'вопросы повторяются');
  for (const f of GEO_AUDIT_FAQ) {
    assert.ok(f.a.length >= 120, `ответ короче 120 символов: ${f.q}`);
    // Цена в ответах должна совпадать с прайсом, а не жить своей жизнью.
    if (f.a.includes('₽')) {
      assert.ok(
        f.a.includes(rur(GEO_AUDIT_OFFER.price)),
        `в ответе цена, отличная от ${rur(GEO_AUDIT_OFFER.price)} ₽: ${f.q}`,
      );
    }
  }
});

test('обещания страницы подкреплены составом работ', () => {
  // Обещали повторный замер через 30 дней — он должен быть в списке «что входит».
  assert.ok(
    GEO_AUDIT_INCLUDES.some((i) => /30 дней/.test(i)),
    'в «что входит» нет повторного замера через 30 дней',
  );
  // Формулы метрик — на странице методики: без них «цифры проверяемы» не проверить.
  assert.equal(GEO_METRICS.length, 3);
  for (const m of GEO_METRICS) {
    assert.ok(m.formula.trim().length > 10, `${m.name}: пустая формула`);
    assert.ok(m.example.trim().length > 5, `${m.name}: нет примера расчёта`);
  }
  // Границы должны быть отрицательными по смыслу, а не списком преимуществ.
  assert.ok(GEO_AUDIT_LIMITS.length >= 3);
  assert.ok(GEO_AUDIT_STEPS.length === 4);
});

test('llms.txt: цена аудита и ссылка есть в файле для моделей', () => {
  const llms = readFileSync(new URL('../../public/llms.txt', import.meta.url), 'utf8');
  assert.ok(llms.includes(`${rur(GEO_AUDIT_OFFER.price)} ₽`), 'в llms.txt нет цены аудита');
  assert.ok(llms.includes(`${SITE_URL}/geo-audit/`), 'в llms.txt нет ссылки на /geo-audit/');
  assert.ok(
    llms.includes(`${SITE_URL}/geo-audit/methodology/`),
    'в llms.txt нет ссылки на методику',
  );
});

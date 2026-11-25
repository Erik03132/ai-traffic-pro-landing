/**
 * Тесты открытых цен и `Offer` в JSON-LD (24.11.2026).
 *
 * Зачем: цена — единственное обещание на сайте, которое проверяется
 * деньгами. Ошибка тут (ноль, отрицательное, «за месяц» вместо «разово»)
 * попадает сразу в три места: страницу услуги, разметку и `/llms-full.txt`,
 * и модель процитирует её как факт. Тест держит данные в согласии.
 *
 * Правка цены = правка `src/data/services/*.ts`, тест проверит форму сам.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { geo } from '../data/services/geo.ts';
import { seo } from '../data/services/seo.ts';
import { smm } from '../data/services/smm.ts';
import { advertising } from '../data/services/advertising.ts';
import { landing } from '../data/services/landing.ts';
import type { Service } from '../data/types.ts';
import { offersLd } from './prices.ts';

const ALL: Service[] = [geo, seo, smm, advertising, landing];

test('цены: только целые рубли и только «мес» / «разово»', () => {
  for (const s of ALL) {
    for (const p of s.prices ?? []) {
      assert.ok(Number.isInteger(p.from), `${s.slug}: цена не целое число — ${p.from}`);
      assert.ok(p.from > 0, `${s.slug}: цена должна быть больше нуля`);
      assert.ok(['мес', 'разово'].includes(p.unit), `${s.slug}: неизвестный период — ${p.unit}`);
      assert.ok(p.label.trim().length > 0, `${s.slug}: цена без названия`);
    }
  }
});

test('цены: вилка ниже публичного рыночного ориентира', () => {
  // docs/pricing-and-positioning.md: рынок − 20%. Если цифру поднимут выше
  // ориентира, «дешевле рынка» перестаёт быть правдой — это ловим здесь.
  const market: Record<string, Record<string, number>> = {
    seo: { 'SEO-продвижение, база': 40_000, 'SEO-продвижение, расширенный': 70_000 },
    geo: { 'GEO-продвижение': 86_000, 'GEO-аудит': 39_000, 'GEO-консультация': 20_000 },
    advertising: { 'Настройка и ведение рекламы': 29_990 },
    landing: { 'Лендинг под ключ': 30_000, 'Сайт компании': 30_000 },
  };

  for (const [slug, prices] of Object.entries(market)) {
    const service = ALL.find((s) => s.slug === slug);
    assert.ok(service, `${slug}: услуга не найдена`);
    for (const [label, ceiling] of Object.entries(prices)) {
      const found: { from: number } | undefined = service.prices?.find((p) => p.label === label);
      assert.ok(found, `${slug}: нет цены «${label}»`);
      assert.ok(found.from < ceiling, `${slug}/${label}: цена ${found.from} не ниже рынка ${ceiling}`);
    }
  }
});

test('Offer: собирается из данных и несёт период', () => {
  const service = geo;
  const offers = offersLd(service, 'https://ai-traffic-pro.ru');
  assert.equal(offers.length, service.prices?.length);
  for (const o of offers) {
    assert.equal(o.priceCurrency, 'RUB');
    assert.ok(o.price > 0);
    assert.ok(['месяц', 'разово'].includes(o.priceSpecification.unitText));
    assert.equal(o.price, o.priceSpecification.price);
  }
  const audit = offers.find((o) => o.name === 'GEO-аудит');
  assert.ok(audit);
  assert.equal(audit.price, 29_000);
  assert.equal(audit.priceSpecification.unitText, 'разово');
});

test('Offer: нет цен — нет разметки (пустой Offer читается как «бесплатно»)', () => {
  assert.equal(smm.prices, undefined);
  assert.deepEqual(offersLd(smm, 'https://ai-traffic-pro.ru'), []);
});

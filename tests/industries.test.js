/**
 * Отраслевые страницы (C6, 25.11.2026).
 *
 * Зачем тест: страница отрасли — это обещание конкретной услуги по конкретной
 * цене. Если из данных исчезнет запрос, цена разойдётся с GEO-аудитом или
 * останется два запроса вместо трёх, страница станет красивой, но пустой.
 * Ошибка не видна в вёрстке — только в ответе клиенту и в цитате модели.
 *
 * Запуск: node --test tests/industries.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { INDUSTRIES } from '../src/data/industries/index.ts';
import { GEO_AUDIT_OFFER } from '../src/data/geo-audit.ts';

test('список отраслей не пуст и slug уникален', () => {
  assert.ok(INDUSTRIES.length >= 1, 'нет ни одной отрасли');
  const slugs = INDUSTRIES.map((i) => i.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slug повторяется');
});

for (const industry of INDUSTRIES) {
  test(`${industry.slug}: ровно 3 запроса с ответом и страницей`, () => {
    assert.equal(industry.queries.length, 3, 'запросов должно быть три');
    for (const q of industry.queries) {
      assert.ok(q.type.trim(), 'у запроса нет типа');
      assert.ok(q.example.trim(), 'у запроса нет примера');
      assert.ok(q.answer.trim().length > 40, 'ответ на запрос слишком короткий');
      assert.ok(q.page.trim(), 'не сказано, что нужно на сайте');
    }
    assert.equal(new Set(industry.queries.map((q) => q.type)).size, 3, 'типы запросов повторяются');
  });

  test(`${industry.slug}: цена старта совпадает с GEO-аудитом`, () => {
    assert.equal(industry.offer.price, GEO_AUDIT_OFFER.price);
    assert.match(industry.offer.days, new RegExp(String(GEO_AUDIT_OFFER.days)));
    assert.ok(industry.offer.includes.length >= 3, 'в оффере меньше трёх пунктов');
    assert.ok(industry.offer.cta.trim(), 'у оффера нет кнопки');
  });

  test(`${industry.slug}: блоки страницы заполнены, а не заглушки`, () => {
    assert.ok(industry.pains.length >= 3, 'мало проблем отрасли');
    assert.ok(industry.works.length >= 6, 'мало работ');
    assert.equal(industry.roles.length, 3, 'должны быть три роли покупателя');
    assert.equal(industry.steps.length, 4, 'должно быть четыре шага');
    assert.ok(industry.metrics.length >= 3, 'мало метрик');
    assert.ok(industry.faq.length >= 8, 'мало вопросов');
    for (const text of [industry.lead, industry.seoDescription, ...industry.works.map((w) => w.text)]) {
      assert.ok(!/lorem|TODO|заглушка/i.test(text), 'в тексте осталась заглушка');
    }
  });

  test(`${industry.slug}: источники — внешние https, статьи существуют`, () => {
    assert.ok(industry.sources.length >= 3, 'мало источников');
    for (const s of industry.sources) {
      assert.match(s.url, /^https:\/\//, `источник не https: ${s.url}`);
      assert.ok(s.title.trim(), 'у источника нет названия');
    }
    assert.ok(industry.relatedArticles.length >= 2, 'нет перелинковки со статьями');
    for (const slug of industry.relatedArticles) {
      assert.match(slug, /^[a-z0-9-]+$/, `странный slug статьи: ${slug}`);
    }
  });

  test(`${industry.slug}: H1 из двух строк и SEO-поля в лимитах`, () => {
    assert.equal(industry.h1.split('|').length, 2, 'H1 должен быть из двух строк');
    assert.ok(industry.seoTitle.length <= 80, 'seoTitle длиннее 80 символов');
    assert.ok(industry.seoDescription.length <= 180, 'seoDescription длиннее 180 символов');
  });
}

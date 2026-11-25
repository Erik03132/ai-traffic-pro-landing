/**
 * Проверяемые факты на страницах услуг (3.3 ROADMAP, 25.11.2026).
 *
 * Зачем тест: блок «Проверяемые факты» существует, чтобы модель могла
 * процитировать утверждение со ссылкой и датой. Факт без источника — просто
 * очередное обещание, а выдуманная цифра хуже её отсутствия. Тест ловит
 * оба случая: пустую вилку и утверждение, которому некуда сослаться.
 *
 * Запуск: node --test tests/service-facts.test.js
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

// Прямые импорты файлов: индексы услуг и блога используют extensionless-
// импорты, которые Node не разрешает при запуске теста без сборщика.
import { leadgen } from '../src/data/services/leadgen.ts';
import { seo } from '../src/data/services/seo.ts';
import { smm } from '../src/data/services/smm.ts';
import { advertising } from '../src/data/services/advertising.ts';
import { landing } from '../src/data/services/landing.ts';
import { crm } from '../src/data/services/crm.ts';
import { ecommerce } from '../src/data/services/ecommerce.ts';
import { geo } from '../src/data/services/geo.ts';

const ALL_SERVICES = [leadgen, seo, smm, advertising, landing, crm, ecommerce, geo];

// Файлы статей проверяем по наличию, а не импортом: они тянут authors.ts
// с extensionless-импортом, который Node не разрешает без сборщика.
const ARTICLE_SLUGS = ['voronka-prodazh-kak-postroit', 'kak-nachat-prodavat-na-marketpleysah'];
for (const slug of ARTICLE_SLUGS) {
  assert.ok(existsSync(new URL(`../src/data/blog/${slug}.ts`, import.meta.url)), `нет статьи ${slug}`);
}

/** Внутренние адреса, на которые разрешено ссылаться из фактов. */
const knownPages = new Set([
  ...ALL_SERVICES.map((s) => `/services/${s.slug}/`),
  '/geo-audit/',
  '/geo-audit/methodology/',
  ...ARTICLE_SLUGS.map((slug) => `/blog/${slug}/`),
]);

test('на страницах услуг не меньше 10 проверяемых фактов', () => {
  const total = ALL_SERVICES.reduce((sum, s) => sum + (s.facts?.length ?? 0), 0);
  assert.ok(total >= 10, `фактов ${total}, нужно не меньше 10 (гейт 3.3 ROADMAP)`);
});

for (const service of ALL_SERVICES) {
  test(`${service.slug}: факты заполнены и привязаны к источнику`, () => {
    assert.ok(service.facts && service.facts.length >= 2, 'у услуги меньше двух фактов');
    for (const fact of service.facts) {
      assert.ok(fact.claim.trim().length >= 30, `слишком короткое утверждение: ${fact.claim}`);
      assert.ok(fact.source.trim(), 'у факта нет названия источника');
      assert.match(fact.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `неверная дата проверки: ${fact.checkedAt}`);
      assert.ok(
        fact.url.startsWith('https://') || fact.url.startsWith('/'),
        `источник не http-адрес и не внутренний путь: ${fact.url}`,
      );
      if (fact.url.startsWith('/')) {
        assert.ok(knownPages.has(fact.url), `факт ссылается на несуществующую страницу: ${fact.url}`);
      }
      assert.ok(
        !/гарантированно|обещаем результат|100% результата/i.test(fact.claim),
        `утверждение обещает результат: ${fact.claim}`,
      );
    }
  });
}

test('утверждения не повторяются между услугами', () => {
  const claims = ALL_SERVICES.flatMap((s) => (s.facts ?? []).map((f) => f.claim));
  assert.equal(new Set(claims).size, claims.length, 'один и тот же факт написан дважды');
});

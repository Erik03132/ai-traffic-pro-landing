/**
 * `Offer` в JSON-LD по открытым ценам услуги.
 *
 * Зачем отдельным модулем: «сколько стоит» — один из самых частых вопросов
 * к модели, и цена цитируется только если она есть в разметке. Логика
 * вынесена из `seo.ts`, чтобы её можно было проверить тестом без загрузки
 * всего контента сайта (`node --test` не умеет импортировать папки).
 *
 * Цены берутся из данных услуги (`prices`), а не из разметки: одна цифра
 * на страницу, JSON-LD и `/llms-full.txt`. Обоснование вилок —
 * `docs/pricing-and-positioning.md`.
 */
import type { Service } from '../data/types';

export function offersLd(service: Service, siteUrl: string) {
  if (!service.prices?.length) return [];
  const url = `${siteUrl}/services/${service.slug}/`;
  return service.prices.map((p) => ({
    '@type': 'Offer',
    name: p.label,
    url,
    price: p.from,
    priceCurrency: 'RUB',
    availability: 'https://schema.org/InStock',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: p.from,
      priceCurrency: 'RUB',
      unitText: p.unit === 'мес' ? 'месяц' : 'разово',
    },
    ...(p.note ? { description: p.note } : {}),
    seller: { '@id': `${siteUrl}/#organization` },
  }));
}

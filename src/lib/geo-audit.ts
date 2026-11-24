/**
 * JSON-LD для `/geo-audit/` — отдельным модулем, а не в разметке страницы.
 *
 * Зачем: `Offer` с ценой и `FAQPage` — это ровно то, что модель цитирует как
 * факт. Проверяются они тестом (`src/lib/geo-audit.test.ts`), а тест не умеет
 * импортировать `.astro`. Логика принимает `siteUrl` параметром по той же
 * причине, что и `prices.ts`: `src/data/site.ts` читает `import.meta.env`
 * и в `node --test` не загружается.
 *
 * Цена не дублируется: `GEO_AUDIT_OFFER.price` — это цена «GEO-аудит» из
 * `src/data/services/geo.ts`.
 */
import { GEO_AUDIT_OFFER } from '../data/geo-audit.ts';

/** `Service` + `Offer` аудита: цена, валюта, период, кто оказывает. */
export function geoAuditLd(siteUrl: string) {
  const url = `${siteUrl}/geo-audit/`;
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${url}#service`,
    name: 'GEO-аудит сайта',
    description:
      'Аудит видимости сайта в ответах нейросетей: шесть машинных сигналов, замер в шести системах, ' +
      'Citation Rate, Share of Voice и Brand Mention Rate с формулами и сырыми ответами. Пять рабочих дней.',
    url,
    serviceType: 'GEO-аудит сайта',
    provider: { '@id': `${siteUrl}/#organization` },
    areaServed: { '@type': 'Country', name: 'Россия' },
    offers: {
      '@type': 'Offer',
      name: 'GEO-аудит сайта',
      url,
      price: GEO_AUDIT_OFFER.price,
      priceCurrency: GEO_AUDIT_OFFER.currency,
      availability: 'https://schema.org/InStock',
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: GEO_AUDIT_OFFER.price,
        priceCurrency: GEO_AUDIT_OFFER.currency,
        // Аудит — разовая работа, не подписка: «разово» ловит тест.
        unitText: 'разово',
      },
      seller: { '@id': `${siteUrl}/#organization` },
    },
  };
}

/** Хлебные крошки: главная → GEO-аудит (→ методика). */
export function geoAuditBreadcrumbLd(
  siteUrl: string,
  leaf: { name: string; path: string } = { name: 'GEO-аудит сайта', path: '/geo-audit/' },
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: `${siteUrl}/` },
      { '@type': 'ListItem', position: 2, name: leaf.name, item: `${siteUrl}${leaf.path}` },
    ],
  };
}

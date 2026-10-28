/**
 * SEO-слой: единая сборка мета-тегов и JSON-LD.
 *
 * Канон и og:url всегда от `SITE_URL` — иначе поисковик увидит дубль
 * (в старой версии canonical вёз на erik03132.github.io, который 301-редиректит).
 */
import { SITE, SITE_URL, ALL_SERVICES, FAQ } from '../data/site';

export interface PageMeta {
  title: string;
  description: string;
  /** Абсолютный путь от корня: '/', '/services/seo/' */
  path: string;
  /** Тип для og:type */
  type?: 'website' | 'article';
  /** Блокирует индексацию (служебные страницы) */
  noindex?: boolean;
}

export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

export function canonicalOf(path: string): string {
  return absoluteUrl(path);
}

/** Сборка JSON-LD: организация + сайт + услуги + FAQ. */
export function organizationLd() {
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'ProfessionalService',
    '@id': `${SITE_URL}/#organization`,
    name: SITE.name,
    url: SITE_URL,
    description: SITE.description,
    areaServed: { '@type': 'Country', name: 'Россия' },
    knowsLanguage: 'ru-RU',
  };

  // Реквизиты исполнителя (ИП). Пустые поля в разметку не выносим.
  if (SITE.legal.entity) {
    org.legalName = SITE.legal.entity;
    org.taxID = SITE.legal.inn;
  }
  if (SITE.legal.ogrnip) org.identifier = SITE.legal.ogrnip;
  if (SITE.legal.address) {
    org.address = {
      '@type': 'PostalAddress',
      addressLocality: SITE.legal.address,
      addressCountry: 'RU',
    };
  }
  if (SITE.legal.email) org.email = SITE.legal.email;
  if (SITE.legal.phone) org.telephone = SITE.legal.phone;
  if (SITE.legal.telegram) {
    org.contactPoint = {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      url: SITE.bot.link,
      availableLanguage: 'Russian',
    };
  }

  const website = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    url: SITE_URL,
    name: SITE.name,
    inLanguage: 'ru-RU',
    publisher: { '@id': `${SITE_URL}/#organization` },
  };

  // ALL_SERVICES, а не SERVICES: CRM — дополнительное направление, но его
  // страница живёт и должна размечаться как Service (иначе теряет JSON-LD).
  const services = ALL_SERVICES.map((s) => ({
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${SITE_URL}/services/${s.slug}/#service`,
    name: s.title,
    description: s.seoDescription,
    url: `${SITE_URL}/services/${s.slug}/`,
    serviceType: s.title,
    provider: { '@id': `${SITE_URL}/#organization` },
    areaServed: { '@type': 'Country', name: 'Россия' },
    audience: { '@type': 'BusinessAudience', name: s.forWhom },
  }));

  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${SITE_URL}/#faq`,
    mainEntity: FAQ.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return [org, website, ...services, faq];
}

/** JSON-LD одной услуги — для страницы услуги. */
export function serviceLd(slug: string) {
  const s = ALL_SERVICES.find((x) => x.slug === slug);
  if (!s) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${SITE_URL}/services/${s.slug}/#service`,
    name: s.title,
    description: s.seoDescription,
    url: `${SITE_URL}/services/${s.slug}/`,
    serviceType: s.title,
    provider: { '@id': `${SITE_URL}/#organization` },
    areaServed: { '@type': 'Country', name: 'Россия' },
    audience: { '@type': 'BusinessAudience', name: s.forWhom },
  };
}

/** JSON-LD FAQ для страницы услуги. */
export function faqLd(items: readonly { q: string; a: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

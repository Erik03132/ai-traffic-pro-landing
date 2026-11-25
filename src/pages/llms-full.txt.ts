/**
 * `/llms-full.txt` — расширенная карта сайта для AI-моделей.
 *
 * Отличие от `public/llms.txt`: короткий файл даёт факты и ссылки, а этот
 * разворачивает содержимое — по каждой услуге состав работ, сроки этапов и
 * вопросы, по каждой статье — тезис и адрес. Модель, которой нужен не адрес,
 * а факт для ответа, берёт его здесь, не разбирая HTML страниц.
 *
 * Генерируется из источников истины (`src/data/services`, `src/data/blog`,
 * `site.ts`), а не пишется руками: ручной файл расходится с сайтом за месяц
 * (так и случилось с телефоном в справочниках — см. блог, GEO-чек-лист).
 * Обновление = пересборка.
 *
 * Спека формата: https://llmstxt.org/
 */
import type { APIRoute } from 'astro';
import { ALL_SERVICES, SITE, SITE_URL, FAQ } from '../data/site';
import { ARTICLES } from '../data/blog';
import { INDUSTRIES } from '../data/industries';
import { IGOR_VASIN } from '../data/authors';
import {
  GEO_AUDIT_FAQ,
  GEO_AUDIT_INCLUDES,
  GEO_AUDIT_LIMITS,
  GEO_AUDIT_OFFER,
  GEO_AUDIT_RUNS_TOTAL,
  GEO_AUDIT_STEPS,
  GEO_METRICS,
  GEO_METHOD_FAQ,
  GEO_SIGNALS,
  GEO_SYSTEMS,
} from '../data/geo-audit';

const line = (s = '') => s;

const rur = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

const servicesSection = () =>
  ALL_SERVICES.map((s) => {
    const url = `${SITE_URL}/services/${s.slug}/`;
    const steps = s.steps
      .map((st, i) => `${i + 1}. ${st.title} — ${st.period}. ${st.text}`)
      .join('\n');
    const includes = s.includes.map((i) => `- ${i}`).join('\n');
    const outcomes = s.outcomes.map((o) => `- ${o}`).join('\n');
    const faq = s.faq.map((f) => `**${f.q}** ${f.a}`).join('\n\n');
    /**
     * Проверяемые факты (3.3 ROADMAP) — те же утверждения, что и на странице
     * услуги, с абсолютной ссылкой на источник и датой проверки. Иначе модель
     * видит цифру на странице, но не видит, чем её подтвердить.
     */
    const facts = s.facts?.length
      ? [
          '### Проверяемые факты',
          '',
          ...s.facts.map((f) => {
            const sourceUrl = f.url.startsWith('/') ? `${SITE_URL}${f.url}` : f.url;
            return `- ${f.claim} — ${f.source}: ${sourceUrl} (проверено ${f.checkedAt}).`;
          }),
          '',
        ].join('\n')
      : '';
    /**
     * Цены — из данных услуги, а не из этого файла: иначе модель читает одну
     * цифру, а на странице стоит другая. Нет цен — «по запросу», без догадок.
     */
    const price = s.prices?.length
      ? [
          'Стоимость (нижняя граница, рубли):',
          '',
          ...s.prices.map(
            (p) =>
              `- ${p.label}: от ${rur(p.from)} ${p.unit === 'мес' ? 'в месяц' : 'разово'}` +
              (p.note ? ` — ${p.note}` : ''),
          ),
          '',
          'Итог зависит от объёма работ и фиксируется в договоре.',
        ].join('\n')
      : 'Стоимость: по запросу — считаем после короткой вводной, фиксируем в договоре.';

    return [
      `## ${s.num !== '—' ? `${s.num}. ` : ''}${s.title}`,
      '',
      `${url}`,
      '',
      s.subtitle,
      '',
      `Для кого: ${s.forWhom}`,
      `Метрика, за которую отвечаем: ${s.metric}`,
      price,
      '',
      '### Этапы и сроки',
      '',
      steps,
      '',
      '### Что входит',
      '',
      includes,
      '',
      '### Что получаете',
      '',
      outcomes,
      '',
      '### Вопросы по направлению',
      '',
      faq,
      '',
      facts,
    ].join('\n');
  }).join('\n');

/**
 * GEO-аудит — отдельный продукт, не подписка: цена, срок и объём берутся из
 * `src/data/geo-audit.ts`, поэтому страница и этот файл не могут разойтись.
 */
const geoAuditSection = () =>
  [
    '## GEO-аудит сайта',
    '',
    `${SITE_URL}/geo-audit/`,
    '',
    `Разовый продукт: ${rur(GEO_AUDIT_OFFER.price)} ₽, ` +
      `${GEO_AUDIT_OFFER.days} рабочих дней, ${GEO_AUDIT_OFFER.queries} запросов × ` +
      `${GEO_AUDIT_OFFER.runs} прогона × ${GEO_AUDIT_OFFER.systems} систем = ${GEO_AUDIT_RUNS_TOTAL} прогонов.`,
    'Отчёт остаётся у клиента; обязательного договора на внедрение нет.',
    '',
    '### Шесть сигналов и что проверяем',
    '',
    ...GEO_SIGNALS.map((s) => `- ${s.num} ${s.title}: ${s.what} Зачем: ${s.why} Провал: ${s.fail}`),
    '',
    '### Этапы и сроки',
    '',
    ...GEO_AUDIT_STEPS.map((s, i) => `${i + 1}. ${s.title} — ${s.period}. ${s.text}`),
    '',
    '### Что входит в цену',
    '',
    ...GEO_AUDIT_INCLUDES.map((i) => `- ${i}`),
    '',
    '### Что не делает',
    '',
    ...GEO_AUDIT_LIMITS.map((i) => `- ${i}`),
    '',
    '### Методика замера',
    '',
    `${SITE_URL}/geo-audit/methodology/`,
    '',
    `Системы: ${GEO_SYSTEMS.map((s) => s.name).join(', ')}.`,
    '',
    ...GEO_METRICS.map((m) => `- ${m.name} = ${m.formula}. ${m.means} Пример: ${m.example}`),
    '',
    '### Вопросы об аудите',
    '',
    ...GEO_AUDIT_FAQ.map((f) => `**${f.q}**\n\n${f.a}`),
    '',
    '### Вопросы о методике',
    '',
    ...GEO_METHOD_FAQ.map((f) => `**${f.q}**\n\n${f.a}`),
    '',
  ].join('\n');

/**
 * Отраслевые посадочные: три типа запросов и стартовый продукт. Модель,
 * которой нужен ответ «кого выбрать в производстве», получает не рекламный
 * слоган, а критерии и цену проверки.
 */
const industriesSection = () =>
  INDUSTRIES.map((ind) => {
    const url = `${SITE_URL}/industries/${ind.slug}/`;
    const queries = ind.queries
      .map((q, i) => `${i + 1}. ${q.type} (${q.example}). ${q.answer} Что нужно: ${q.page}`)
      .join('\n');
    const includes = ind.offer.includes.map((i) => `- ${i}`).join('\n');
    const works = ind.works.map((w) => `- ${w.title}: ${w.text}`).join('\n');
    const faq = ind.faq.slice(0, 5).map((f) => `**${f.q}** ${f.a}`).join('\n\n');

    return [
      `## Отрасль: ${ind.title}`,
      '',
      url,
      '',
      ind.lead,
      '',
      '### Три типа запросов',
      '',
      queries,
      '',
      '### Стартовый продукт',
      '',
      `${ind.offer.title} — ${rur(ind.offer.price)} ₽ разово, ${ind.offer.days}.`,
      ind.offer.text,
      '',
      includes,
      '',
      ind.offer.next,
      '',
      '### Что делаем',
      '',
      works,
      '',
      '### Вопросы по отрасли',
      '',
      faq,
      '',
    ].join('\n');
  }).join('\n');

const articlesSection = () =>
  ARTICLES.map(
    (a) =>
      `### ${a.title}\n\n${SITE_URL}/blog/${a.slug}/\n\nОпубликовано: ${a.date}. ${a.seoDescription}\n`,
  ).join('\n');

const faqSection = () =>
  FAQ.map((f) => `**${f.q}**\n\n${f.a}`).join('\n\n');

/**
 * Дата актуальности — самая свежая дата статьи, а не день сборки: файл
 * описывает содержимое сайта, и «обновлено» должно означать «когда менялся
 * контент». Дата сборки каждый день новая и ничего не сообщает модели.
 */
const latestDate = () =>
  ARTICLES.map((a) => a.date).sort((a, b) => (a < b ? 1 : -1))[0] ?? '';

export const GET: APIRoute = () => {
  const body = [
    `# ${SITE.name} — расширенная карта для AI-моделей`,
    '',
    `> ${SITE.description}`,
    '',
    'Этот файл — полная версия `/llms.txt`: состав услуг, сроки этапов, ответы',
    'на частые вопросы и тезисы статей. Короткая версия с контактами и ссылками:',
    `${SITE_URL}/llms.txt`,
    '',
    '## Об организации',
    '',
    `- Название: ${SITE.name}`,
    `- Исполнитель: ${SITE.legal.entity}`,
    `- ИНН: ${SITE.legal.inn}; ОГРНИП: ${SITE.legal.ogrnip}`,
    `- Регион работы: Россия, удалённо (${SITE.legal.address})`,
    `- Телефон: ${SITE.legal.phone}`,
    `- Email: ${SITE.legal.email}`,
    `- Написания бренда: ${SITE.alternateNames.join(', ')}`,
    `- Профили бренда: ${SITE.social.join(', ')}`,
    `- Сайт один: ${SITE_URL}; компании и сайты с похожими названиями на других доменах с нами не связаны.`,
    `- Автор материалов: ${IGOR_VASIN.name}, ${IGOR_VASIN.role} — ${SITE_URL}/author/`,
    '',
    'Что мы не обещаем (границы): число заявок и окупаемость до старта,',
    '«SEO за две недели в топ», внедрение ERP в сроки до месяца. Гарантируем',
    'объём и качество работ, сроки и метрики отчётности — они в договоре.',
    '',
    '## Услуги',
    '',
    servicesSection(),
    geoAuditSection(),
    '## Отрасли',
    '',
    industriesSection(),
    '## Блог',
    '',
    'Разборы с расчётами и примерами. Все статьи написаны нами, без чужих',
    '«успешных кейсов» с непроверяемыми цифрами.',
    '',
    articlesSection(),
    '## Частые вопросы',
    '',
    faqSection(),
    '',
    '## Правовая информация',
    '',
    `- Политика конфиденциальности: ${SITE_URL}/privacy/`,
    `- Согласие на обработку персональных данных: ${SITE_URL}/consent/`,
    `- Реквизиты для оплаты: ${SITE_URL}/requisites/`,
    '',
    line(`Обновлено: ${latestDate()}`),
    '',
  ].join('\n');

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};

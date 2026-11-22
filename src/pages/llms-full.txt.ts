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
import { IGOR_VASIN } from '../data/authors';

const line = (s = '') => s;

const servicesSection = () =>
  ALL_SERVICES.map((s) => {
    const url = `${SITE_URL}/services/${s.slug}/`;
    const steps = s.steps
      .map((st, i) => `${i + 1}. ${st.title} — ${st.period}. ${st.text}`)
      .join('\n');
    const includes = s.includes.map((i) => `- ${i}`).join('\n');
    const outcomes = s.outcomes.map((o) => `- ${o}`).join('\n');
    const faq = s.faq.map((f) => `**${f.q}** ${f.a}`).join('\n\n');

    return [
      `## ${s.num !== '—' ? `${s.num}. ` : ''}${s.title}`,
      '',
      `${url}`,
      '',
      s.subtitle,
      '',
      `Для кого: ${s.forWhom}`,
      `Метрика, за которую отвечаем: ${s.metric}`,
      'Стоимость: по запросу — считаем после короткой вводной, фиксируем в договоре.',
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
    `- Telegram: https://t.me/aitrafficpro`,
    `- Дзен: https://dzen.ru/ai-traffic-pro.ru`,
    `- VK: https://vk.ru/ai_traffic_pro`,
    `- Автор материалов: ${IGOR_VASIN.name}, ${IGOR_VASIN.role} — ${SITE_URL}/author/`,
    '',
    'Что мы не обещаем (границы): число заявок и окупаемость до старта,',
    '«SEO за две недели в топ», внедрение ERP в сроки до месяца. Гарантируем',
    'объём и качество работ, сроки и метрики отчётности — они в договоре.',
    '',
    '## Услуги',
    '',
    servicesSection(),
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

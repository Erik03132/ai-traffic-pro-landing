/**
 * Типы контента сайта.
 *
 * Вынесены отдельно от `site.ts`, чтобы файлы услуг (`src/data/services/*.ts`)
 * импортировали тип без циклической зависимости: `site.ts` → `services/` → `types.ts`.
 */

export interface Service {
  /** slug — используется в URL `/services/<slug>/`. Один и тот же во всех местах. */
  slug: string;
  /** Номер в списке: «01»…«06». У CRM — «—». */
  num: string;
  title: string;
  /** Короткое описание для карточки на главной. */
  card: string;
  /** Подзаголовок под H1 на странице услуги. */
  subtitle: string;
  /** SEO-заголовок страницы услуги. */
  seoTitle: string;
  /** SEO-описание страницы услуги. */
  seoDescription: string;
  /** H1 страницы услуги. */
  h1: string;
  /** С какой проблемой приходят — 3 типичные боли. */
  problem: { title: string; text: string }[];
  /** Как решаем — 4 конкретных шага решения. */
  solution: { title: string; text: string }[];
  /** Кому подходит — 4 карточки. */
  audience: { title: string; text: string }[];
  /** Как это работает — 4 шага. `period` — срок работы по этапу. */
  steps: { title: string; text: string; period: string }[];
  /** Что входит — 8 пунктов. */
  includes: string[];
  /** Что получите — 4 пункта. */
  outcomes: string[];
  /** FAQ услуги — 9 вопросов. */
  faq: { q: string; a: string }[];
  /** Метрика, за которую отвечает услуга. */
  metric: string;
  /** Кому это нужно — строка для карточки. */
  forWhom: string;
  /** Короткая метка для бейджа карточки. */
  badge: string;
  /** Иконка Material Symbols. */
  icon: string;
  /** Входит в 6 карточек главной / футера / sitemap. */
  inMain: boolean;
}

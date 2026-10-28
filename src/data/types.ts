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

/** Блок статьи: раздел с заголовком и одним из видов содержимого. */
export interface ArticleBlock {
  /** Заголовок раздела (h2). */
  title: string;
  /** Абзацы. */
  paragraphs?: string[];
  /** Маркированный список. */
  list?: string[];
  /** Нумерованные шаги (для инструкций). */
  steps?: string[];
}

/**
 * Статья блога. Одна статья — один файл `src/data/blog/<slug>.ts`.
 *
 * `service` — slug услуги, к которой относится материал: из него строится
 * перелинковка «статья → страница услуги» (задача 2.7 ROADMAP).
 */
export interface Article {
  slug: string;
  /** Slug услуги-кластера (leadgen, seo, smm, advertising, landing, ecommerce, crm). */
  service: string;
  /** H1 статьи. */
  title: string;
  seoTitle: string;
  seoDescription: string;
  /** Вводный абзац под H1. */
  lead: string;
  /** Дата публикации, ISO (YYYY-MM-DD). */
  date: string;
  /** Время чтения в минутах. */
  readingTime: number;
  /** Метка для карточки в списке статей. */
  tag: string;
  /** Разделы статьи по порядку. */
  sections: ArticleBlock[];
  /** Вопросы в конце статьи (3 штуки). */
  faq: { q: string; a: string }[];
}

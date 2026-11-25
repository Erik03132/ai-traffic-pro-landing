/**
 * Типы контента сайта.
 *
 * Вынесены отдельно от `site.ts`, чтобы файлы услуг (`src/data/services/*.ts`)
 * импортировали тип без циклической зависимости: `site.ts` → `services/` → `types.ts`.
 */

/**
 * Открытая цена услуги.
 *
 * Зачем в данных, а не в разметке: одну и ту же цифру видят посетитель
 * страницы, JSON-LD (`Offer`) и `/llms-full.txt`. Три копии разъезжаются
 * за месяц — цифра в разметке остаётся прошлогодней.
 *
 * Правило источника (24.11.2026): публикуем только там, где есть публичный
 * рыночный ориентир, и держим «рынок − 20%». Обоснование и таблица —
 * `docs/pricing-and-positioning.md`. Придуманных цифр здесь нет.
 */
export interface ServicePrice {
  /** Что именно стоит этих денег: «продвижение», «аудит», «расширенный тариф». */
  label: string;
  /** Нижняя граница вилки, рублей. */
  from: number;
  /** За какой период платят. */
  unit: 'мес' | 'разово';
  /** Что входит — чтобы цифра не висела без объёма работ. */
  note?: string;
}

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

  /**
   * Открытые цены (24.11.2026). Пусто — «по запросу», и это честно:
   * цифра без рыночного ориентира была бы выдумкой (`docs/CONTENT_SPEC.md` §6).
   */
  prices?: ServicePrice[];

  /** Специфический слой интеграций (как GEO для SEO) — опционально. */
  integrationLayer?: { title: string; text: string; icon: string }[];
  /** Технологический стек / системы — опционально. */
  techStack?: { name: string; desc: string }[];

  /** Площадки для SMM (аналог Tech Stack) — опционально. */
  platforms?: { name: string; desc: string }[];
  /** Форматы контента для SMM (аналог Integration Layer) — опционально. */
  contentFormats?: { title: string; text: string; icon: string }[];

  /** Рекламные каналы (аналог Platforms) — опционально. */
  channels?: { name: string; desc: string }[];
  /** Форматы и инструменты рекламы (аналог Content Formats) — опционально. */
  adFormats?: { title: string; text: string; icon: string }[];

  /** Контент-план и бесплатные посты (органика) — опционально. */
  contentPlan?: {
    title: string;
    text: string;
    platforms: { name: string; desc: string; formats: string[] }[];
    process: string[];
    metrics: string[];
  }[];

  /** Типы сайтов и лендингов (аналог Platforms) — опционально. */
  siteTypes?: { name: string; desc: string }[];
  /** Что проверяем перед запуском (аналог Integration Layer) — опционально. */
  launchChecks?: { title: string; text: string; icon: string }[];

  /** Этапы воронки продаж с метрикой каждого — опционально. */
  funnelStages?: { name: string; desc: string; metric: string }[];
  /** Каналы привлечения клиентов — опционально. */
  leadChannels?: { name: string; desc: string }[];
  /** Как устроена квалификация обращения — опционально. */
  qualification?: { title: string; text: string; icon: string }[];

  /** Площадки продаж: свой магазин и маркетплейсы — опционально. */
  salesChannels?: { name: string; desc: string }[];
  /** Из чего состоит карточка товара — опционально. */
  cardParts?: { title: string; text: string; icon: string }[];
  /** Что синхронизируем между площадками — опционально. */
  dataSync?: { title: string; text: string; icon: string }[];
  /**
   * Таблица сравнения — главный GEO-блок страницы: модели цитируют таблицу
   * целиком, а не пересказывают абзацы. Числа в ячейках — ориентиры, которые
   * проверяются на вводной, поэтому в тексте это оговорено.
   */
  comparison?: {
    title: string;
    intro?: string;
    head: string[];
    rows: string[][];
  };
  /**
   * Внешние первоисточники: официальная документация платформ и стандартов.
   * Нужны, чтобы утверждения на странице можно было проверить, — это условие
   * цитируемости в ответах ИИ, а не «ссылочный вес».
   */
  sources?: { title: string; url: string; note?: string }[];
}

/**
 * Отраслевая посадочная страница (C6, 25.11.2026).
 *
 * Три запроса — три типа намерения, а не три ключевых слова. У каждого своя
 * страница и свой ответ, поэтому `queries` описывает не только фразу, но и
 * что именно должно быть на сайте, чтобы её закрыть.
 */
export interface Industry {
  /** slug в URL: `/industries/<slug>/`. */
  slug: string;
  title: string;
  shortTitle: string;
  badge: string;
  /** Дата правки содержимого — для sitemap, а не дата сборки. */
  updated: string;
  /** H1: две строки через `|`, вторая — акцентная. */
  h1: string;
  seoTitle: string;
  seoDescription: string;
  /** Первый абзац: прямой ответ, который может цитировать модель. */
  lead: string;
  queries: {
    type: string;
    example: string;
    answer: string;
    page: string;
  }[];
  pains: { title: string; text: string }[];
  offer: {
    title: string;
    text: string;
    price: number;
    days: string;
    includes: string[];
    next: string;
    cta: string;
  };
  works: { title: string; text: string; icon: string }[];
  roles: { role: string; question: string; answer: string }[];
  steps: { title: string; text: string; period: string }[];
  metrics: { name: string; formula: string; means: string }[];
  faq: { q: string; a: string }[];
  sources: { title: string; url: string; note?: string }[];
  /** Slug статей блога для перелинковки. */
  relatedArticles: string[];
}

/** Блок статьи: раздел с заголовком и одним из видов содержимого. */
export interface ArticleBlock {
  /** Заголовок раздела (h2). */
  title: string;
  /** Абзацы. Можно вставлять ссылки тегом <a href="…">. */
  paragraphs?: string[];
  /** Маркированный список. */
  list?: string[];
  /** Нумерованные шаги (для инструкций). */
  steps?: string[];
  /** Подразделы (h3) внутри раздела — нужны для цитирования по пассажу. */
  sub?: {
    title: string;
    paragraphs?: string[];
    list?: string[];
  }[];
  /** Таблица сравнения. Модели выдёргивают таблицу целиком — это главный GEO-блок. */
  table?: {
    head: string[];
    rows: string[][];
  };
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
  /**
   * Обложка статьи: путь от корня сайта (например `/blog/<slug>.jpg`).
   * Необязательное поле: статья без обложки работает, но карточка в
   * соцсетях (og:image) будет без картинки.
   */
  image?: string;
  /** Разделы статьи по порядку. */
  sections: ArticleBlock[];
  /** Вопросы в конце статьи (3 штуки). */
  faq: { q: string; a: string }[];
  /**
   * Автор-человек. Нужен для E-E-A-T и для разметки Person: ИИ и Яндекс
   * доверяют подписанному тексту больше, чем «написала организация».
   */
  author?: {
    name: string;
    role: string;
  };
  /** Первоисточники: на них ссылаются утверждения и цифры в тексте. */
  sources?: {
    label: string;
    url: string;
  }[];
}

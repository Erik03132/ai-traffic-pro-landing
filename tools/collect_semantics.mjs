/**
 * Сбор семантического ядра из открытых источников (без Wordstat/Keys.so).
 *
 * Источники:
 *   1. Яндекс suggest (suggest.yandex.ru)  — реальные формулировки пользователей
 *   2. Google suggest (suggestqueries)    — то же, второй движок
 *   3. Alphabet expand (корень + буква)   — до 500+ вариантов на один корень
 *   4. hh.ru (в браузере)                — спрос рынка = объём вакансий
 *   5. Google Trends (в браузере)         — относительная частота 0-100
 *
 * Запуск: node tools/collect_semantics.mjs [--out docs/semantics/keywords.json]
 *
 * Частотность: Яндекс suggest отдаёт «popularity» в ответе — это порядок
 * (не число), поэтому числовую частотность даёт hh.ru (вакансии) и Trends.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const YANDEX = 'https://suggest.yandex.ru/suggest-ya.cgi?v=4&part=';
const GOOGLE = 'https://suggestqueries.google.com/complete/search?client=firefox&hl=ru&q=';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюя';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ответ suggest может содержать не только строки — приводим к строке. */
function asString(item) {
  if (typeof item === 'string') return item;
  if (Array.isArray(item)) return asString(item[0]);
  if (item && typeof item === 'object')
    return asString(item.value ?? item.query ?? item.text ?? '');
  return '';
}

/** Яндекс suggest: возвращает массив подсказок. */
async function yandexSuggest(query) {
  const d = await fetchJson(YANDEX + encodeURIComponent(query));
  return Array.isArray(d?.[1]) ? d[1].map(asString).filter(Boolean) : [];
}

/** Google suggest: тот же формат. */
async function googleSuggest(query) {
  const d = await fetchJson(GOOGLE + encodeURIComponent(query));
  return Array.isArray(d?.[1]) ? d[1].map(asString).filter(Boolean) : [];
}

/**
 * Alphabet expand: спрашиваем «корень + буква» и оставляем только продолжения
 * корня. Так собираются длинные хвосты («интернет-магазин вб» и т.п.).
 */
async function alphabetExpand(root, engine) {
  const fn = engine === 'google' ? googleSuggest : yandexSuggest;
  const out = new Set();
  await Promise.all(
    [...ALPHABET].map(async (ch) => {
      const res = await fn(`${root} ${ch}`);
      for (const item of res) {
        const low = item.toLowerCase();
        if (low.startsWith(root.toLowerCase())) out.add(item);
      }
    }),
  );
  return [...out];
}

/**
 * Seed-слова по услугам. Корни подобраны по замеру спроса hh.ru (28.10.2026):
 * «интернет-магазин» — 12 945 вакансий, «e-commerce» — 4 109 и т.д.
 */
const CLUSTERS = [
  {
    id: 'ecommerce',
    num: '06',
    title: 'E-commerce: интернет-магазин и маркетплейсы',
    roots: [
      'интернет-магазин',
      'e-commerce',
      'маркетплейс',
      'карточки товаров',
      'каталог товаров',
      'продвижение на маркетплейсах',
      'разработка интернет-магазина',
      'создание интернет-магазина',
      'интернет-магазин под ключ',
      'оформление карточек',
      'выгрузка товаров',
      'продажи на маркетплейсах',
      'выход на маркетплейс',
      'продвижение товаров',
      'инфографика для маркетплейсов',
      'аналитика маркетплейсов',
      'управление продажами',
      'продвижение вб',
      'продвижение озона',
      'сопровождение маркетплейсов',
      'оформление карточек товаров',
      'загрузка товаров',
      'карточки для маркетплейсов',
      'наполнение карточек товаров',
      'каталог для маркетплейса',
      'продавцу на маркетплейсе',
      'как продавать на маркетплейсе',
      'как выбрать маркетплейс',
      'старт продаж на маркетплейсе',
      'e-commerce услуги',
      'помощь с маркетплейсом',
    ],
  },
  {
    id: 'seo',
    num: '02',
    title: 'SEO, GEO и видимость в ИИ',
    roots: [
      'seo продвижение',
      'продвижение в нейросетях',
      'оптимизация сайта',
      'продвижение сайта',
      'техническое сео',
      'geo оптимизация',
      'seo услуги',
      'seo продвижение сайтов',
      'аудит сайта',
      'продвижение в google',
      'продвижение в яндексе',
      'оптимизация сайта под нейросети',
      'попасть в ответы нейросети',
    ],
  },
  {
    id: 'leadgen',
    num: '01',
    title: 'Привлечение клиентов и воронка продаж',
    roots: [
      'привлечение клиентов',
      'воронка продаж',
      'лидогенерация',
      'генерация заявок',
      'привлечение целевой аудитории',
      'привлечение клиентов в интернет',
      'как привлекать клиентов',
      'заявки с сайта',
      'обработка заявок',
      'лид менеджер',
      'конверсия в заявку',
      'лиды',
      'скрипты продаж',
      'холодные звонки',
      'перфоманс маркетинг',
      'продвижение бизнеса',
      'воронка продаж в интернете',
      'автоматизация продаж',
    ],
  },
  {
    id: 'smm',
    num: '03',
    title: 'SMM и ведение соцсетей',
    roots: [
      'smm',
      'ведение соцсетей',
      'продвижение в соцсетях',
      'контент для соцсетей',
      'smm продвижение',
      'smm услуги',
      'контент план',
      'дизайн для соцсетей',
      'таргет в инстаграм',
      'ведение инстаграм',
      'ведение telegram канала',
      'съёмка контента',
    ],
  },
  {
    id: 'advertising',
    num: '04',
    title: 'Контекстная и таргетированная реклама',
    roots: [
      'настройка рекламы',
      'яндекс директ',
      'таргетированная реклама',
      'контекстная реклама',
      'реклама в интернете',
      'настройка яндекс директ',
      'реклама в telegram',
      'реклама в вк',
      'ведение рекламы',
      'аудит рекламы',
      'медиаплан',
    ],
  },
  {
    id: 'landing',
    num: '05',
    title: 'Сайт или лендинг под ключ',
    roots: [
      'разработка сайта',
      'лендинг под ключ',
      'создание сайта',
      'дизайн сайта',
      'разработка лендинга',
      'сайт для бизнеса',
      'корпоративный сайт',
      'интернет-магазин сайт',
      'вёрстка сайта',
      'прототип сайта',
    ],
  },
  {
    id: 'crm',
    num: '07',
    title: 'CRM и автоматизация маркетинга',
    roots: [
      'crm',
      'crm система',
      'внедрение crm',
      'настройка crm',
      'bitrix24',
      'amo crm',
      'автоматизация продаж crm',
      'crm для продаж',
      'интеграция crm',
      'настройка amo crm',
      'amo crm настройка',
      'внедрение amo crm',
      'crm система для бизнеса',
      'crm для маркетинга',
      'bitrix24 настройка',
      'внедрение bitrix24',
      'автоматизация продаж в crm',
      'crm для отдела продаж',
      'аналитика в crm',
    ],
  },
];

/**
 * Отсев мусора: подсказки с брендами-расцветками, медиа-контентом и геозапросами.
 *
 * Alphabet expand даёт длинные хвосты, где половина — чужие бренды, пиратка
 * и «что скачать». Всё это не имеет отношения к услуге и в ядро не идёт.
 */
const NOISE = [
  // операторы и торговые площадки (не наши услуги)
  'билайн',
  'мегафон',
  'мтс',
  'теле2',
  'ростелеком',
  'ozon',
  'озон',
  'wildberries',
  'вайлдберриз',
  'aliexpress',
  'алиэкспресс',
  'яндекс маркет',
  'яндекс маркетплейс',
  'avito',
  'авито',
  'dns',
  'мвидео',
  'ситилинк',
  'эльдорадо',
  'леруа',
  'спортмастер',
  'лада',
  'деокт',
  'вб',
  'озон',
  'аптека',
  'аптеки',
  'поликлиника',
  'больница',
  // конкуренты в нише
  'seotica',
  'seo fortuna',
  'fortuna',
  'novelit',
  'top programs',
  'techdeck',
  'впgx',
  'капитель',
  'веред',
  'белый шар',
  'amvera',
  'netology',
  // медиа и пиратка
  'песня',
  'песни',
  'приложение',
  'скачать',
  'торрент',
  'фильм',
  'фильмы',
  'сериал',
  'книга',
  'книги',
  'игра',
  'игры',
  'музыка',
  'клип',
  'клипы',
  'видео',
  'скидка',
  'купон',
  'промокод',
  'вакансии',
  'вакансия',
  'работа',
  'резюме',
  'зарплата',
  'заработок',
  'срочно',
  'учится',
  'обучение',
  'курсы',
  'курс',
  'реферат',
  // бытовые/нерелевантные хвосты
  'купить',
  'официальный',
  'на 2026',
  '2026 год',
  'цены на',
  'магазин',
  'бесплатно',
  'швея',
  'водитель',
  'уборщица',
  'репетитор',
  'косметолог',
  'бухгалтер',
  'юрист',
  'квартира',
  'авто',
  'запчасти',
  'шины',
  'машина',
  'б/у',
  'бу',
];

/**
 * Хвост после корня длиннее трёх слов — это уже другой запрос: оставляем
 * только осмысленные продолжения.
 */
function tailWords(query, root) {
  const q = query.toLowerCase();
  const r = root.toLowerCase();
  const idx = q.indexOf(r);
  if (idx < 0) return null;
  return q
    .slice(idx + r.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Конкуренты, гео и чужие ниши — navigational, в ядро не идут.
 */
const NAV_NOISE = [
  'москва',
  'москве',
  'спб',
  'санкт-петербург',
  'питер',
  'екатеринбург',
  'новосибирск',
  'казань',
  'нижний новгород',
  'челябинск',
  'самара',
  'омск',
  'ростов',
  'уфа',
  'краснодар',
  'воронеж',
  'пермь',
  'волгоград',
  'тюмень',
  'иркутск',
  'барнаул',
  'ульяновск',
  'воронёж',
  'чебоксары',
  'тамбов',
  'тула',
  'липецк',
  'ярославль',
  'тверь',
  'санкт',
  'россия',
  'рф',
  'беларусь',
  'казахстан',
  'алматы',
  'киев',
  'минск',
  'украина',
  'швеция',
  'польша',
  'кипр',
  'турция',
  'израиль',
  'сша',
  'london',
  'new york',
  'индия',
  'китай',
  'гемза',
  'одноклассники',
  'вконтакте',
  'база данных',
  'sql',
  'python',
  'java',
  '1с',
  // ниши, не связанные с нашими услугами
  'питомник',
  'породист',
  'хорь',
  'кошка',
  'собака',
  'приют',
  'зоо',
  'ветеринар',
  'спортзал',
  'бассейн',
  'футбол',
  'хоккей',
  'каратэ',
  'бокс',
  'тату',
  'пирсинг',
  'свадьба',
  'фотосессия',
  'фотограф',
  'такси',
  'переезд',
  'клининг',
  'ремонт квартир',
  'стоматолог',
  'ортодонт',
  'пластик',
  'имплантация',
  'бухгалтерские услуги',
  'патент',
  'юрист',
  'адвокат',
  'нотариус',
  'страховка',
  'кредит',
  'займ',
  'микрозайм',
  'спортпит',
  'допинг',
  'пробив',
  'жалоба',
  'антибот',
  'спортпит',
];

/**
 * Латинские слова, допустимые в ядре. Всё остальное на латинице — англоязычные
 * запросы или названия чужих сервисов; нам они не нужны.
 */
const LATIN_OK = new Set([
  'seo',
  'geo',
  'aio',
  'aeo',
  'crm',
  'erp',
  'smm',
  'ai',
  'wb',
  'ozon',
  'wildberries',
  'aliexpress',
  'avito',
  'yandex',
  'google',
  'shopify',
  'wordpress',
  'woocommerce',
  'tilda',
  'taplink',
  'bitrix',
  'bitrix24',
  'amo',
  'crm',
  'telegram',
  'vk',
  'dzen',
  'rutube',
  'youtube',
  'chatgpt',
  'gpt',
  'perplexity',
  'notion',
  'figma',
  'photoshop',
  'canva',
  'html',
  'css',
  'react',
  'api',
  'cpc',
  'ctr',
  'cpl',
  'cpa',
  'romi',
  'ltv',
  'kpi',
  'ux',
  'ui',
  'ppc',
  'serp',
  'faq',
  'schema',
  'json',
  'xml',
  'amp',
  'ecom',
  'ecommerce',
  'mail',
  'email',
  'web',
  'site',
  'site',
  'pr',
  'smm',
  'seo',
  'seo',
  'marketplace',
  'market',
  'shop',
  'store',
  'nft',
  'content',
  'specialist',
  'manager',
  'design',
  'designs',
  'trends',
  'report',
  'recommendation',
  'fulfillment',
  'platform',
  'website',
  'bench',
  'satu',
  'brave',
  'sber',
  'tinkoff',
  'sberbank',
  'sberportal',
  'sberchat',
]);

/**
 * Слова, означающие намерение. Без них запрос — просто описание объекта
 * («e-commerce bench», «маркетплейс швеция») и в ядре не нужен.
 */
const INTENT_SIGNALS = [
  'что',
  'как',
  'почему',
  'зачем',
  'чем',
  'где',
  'когда',
  'сколько',
  'нужно ли',
  'можно ли',
  'нужен ли',
  'нужна ли',
  'полезно',
  'пример',
  'виды',
  'типы',
  'разница',
  'отличие',
  'отличается',
  'входит',
  'состоит',
  'устроен',
  'выбрать',
  'обращать внимание',
  'цена',
  'стоимост',
  'стоимость',
  'цены',
  'прайс',
  'дорого',
  'дёшево',
  'дешево',
  'недорого',
  'заказать',
  'заказ',
  'купить',
  'оптом',
  'зависит',
  'зависимость',
  'агентств',
  'услуг',
  'компани',
  'команду',
  'команда',
  'специалист',
  'эксперт',
  'студи',
  'под ключ',
  'наши',
  'настро',
  'настройка',
  'внедри',
  'внедрение',
  'аудит',
  'проверк',
  'анализ',
  'помощь',
  'работа',
  'работы',
  'занима',
  'дела',
  'сделать',
  'продвинут',
  'продвижение',
  'оптимизац',
  'разработк',
  'создани',
  'создать',
  'ведение',
  'веду',
  'консалт',
  'план',
  'схема',
  'выгодно',
  'выгода',
  'результат',
  'эффектив',
  'окупа',
  'окупаем',
  'влия',
  'влияни',
  'для чайников',
  'для начинающих',
  'простыми словами',
  'своими руками',
  'для бизнеса',
  'для компании',
  'для магазина',
  'для сайта',
  'для бренда',
  'для производ',
  'для продавца',
  'оформлени',
  'выгрузк',
  'загрузк',
  'аналитик',
  'сопровождени',
  'интеграц',
  'автоматизац',
  'перенос',
  'синхронизац',
  'модерац',
  'упаковк',
  'наполнени',
  'структур',
  'плант',
  'скрипт',
  'холодн',
  'перфоманс',
  'лид',
  'конверси',
  'воронк',
  'лидогенерац',
  'заявк',
  'обращени',
  'аудит',
  'проверк',
  'оценк',
  'разбор',
  'анализ',
  'внедрен',
  'интеграц',
  'автоматиз',
  'сделк',
  'канал',
  'задач',
  'отчет',
  'настройк',
  'подбор',
  'сопровождени',
  'обучени',
  'миграц',
  'синхронизац',
];

function isNoise(q) {
  const low = q.toLowerCase();
  return NOISE.some((n) => low.includes(n));
}

function isGeoOrCompetitor(q) {
  const low = q.toLowerCase();
  return NAV_NOISE.some((n) => low.includes(n));
}

/** Все латинские токены запроса должны быть в whitelist. */
function hasOnlyAllowedLatin(q) {
  const tokens = q.toLowerCase().match(/[a-z][a-z0-9-]*/g) || [];
  return tokens.every((t) => LATIN_OK.has(t) || t.length <= 2);
}

/** Есть ли в запросе маркер намерения. */
function hasIntentSignal(q) {
  const low = q.toLowerCase();
  return INTENT_SIGNALS.some((m) => low.includes(m));
}

/**
 * Классификация интента. 4 типа, как в Яндексе:
 *   informational — «что такое», «как», «почему»
 *   commercial    — «услуга», «агентство», «цена», «заказать»
 *   transactional — «купить», «скачать» (в нашей нише почти нет)
 *   navigational  — гео-запросы и конкуренты
 *
 * Маркеры ищутся в любом месте строки, а не только в начале: реальные
 * запросы выглядят как «что такое seo продвижение», а не «что seo».
 */
const INTENT_MARKERS = {
  informational: [
    'что такое',
    'что значит',
    'что это',
    'как ',
    'почему',
    'зачем',
    'чем отличается',
    'отличие',
    'разница',
    'нужно ли',
    'можно ли',
    'нужен ли',
    'нужна ли',
    'полезно ли',
    'как сделать',
    'как улучшить',
    'как повысить',
    'как увеличить',
    'что входит',
    'сколько стоит',
    'сколько времени',
    'какие задачи',
    'виды ',
    'типы ',
    'примеры ',
    'как выбрать',
    'на что обращать внимание',
    'как устроен',
    'из чего состоит',
    'что даёт',
    'что дает',
    'зачем нужен',
    'зачем нужна',
    'для чего',
    'нужны ли',
    'в чём разница',
    'в чем разница',
    'что лучше',
    'чем отличается',
  ],
  transactional: ['купить', 'заказать', 'оптом', 'дёшево', 'дешево', 'недорого', 'скачать'],
  commercial: [
    'агентств',
    'услуг',
    'компани',
    'студи',
    'под ключ',
    'цена',
    'стоимост',
    'заказать',
    'ближайш',
    'наши',
    'работ',
    'помощь',
    'занима',
    'дела',
    'сделать',
    'настро',
    'внедри',
    'продвинут',
    'продвижение',
    'оптимизац',
    'разработк',
    'создани',
    'ведение',
    'аудит',
    'анализ',
    'консалт',
    'эксперт',
    'специалист',
    'команда',
  ],
};

function classifyIntent(q) {
  const low = q.toLowerCase();
  if (isGeoOrCompetitor(low)) return 'navigational';
  for (const [intent, markers] of Object.entries(INTENT_MARKERS)) {
    if (markers.some((m) => low.includes(m))) return intent;
  }
  return 'commercial';
}

/** Сбор по одному кластеру. */
async function collectCluster(cluster) {
  const all = new Map(); // формулировка → { engines, roots }

  const add = (item, engine, root) => {
    const key = item.trim().toLowerCase();
    if (!key || key.length < 4) return;
    if (isNoise(key) || isGeoOrCompetitor(key)) return;
    // Латиница вне whitelist — англоязычные запросы и чужие сервисы.
    if (!hasOnlyAllowedLatin(key)) return;
    // Хвост после корня: больше 4 слов — это уже не наш запрос.
    const tail = tailWords(key, root);
    if (tail && tail.length > 4) return;
    // Запрос должен содержать маркер намерения, иначе это описание объекта.
    if (!hasIntentSignal(key)) return;
    if (!all.has(key)) all.set(key, { query: item.trim(), engines: new Set(), roots: new Set() });
    const rec = all.get(key);
    rec.engines.add(engine);
    rec.roots.add(root);
  };

  for (const root of cluster.roots) {
    for (const [engine, fn] of [
      ['yandex', yandexSuggest],
      ['google', googleSuggest],
    ]) {
      for (const item of await fn(root)) add(item, engine, root);
    }
    // Alphabet expand — самый объёмный источник
    for (const engine of ['yandex', 'google']) {
      for (const item of await alphabetExpand(root, engine)) add(item, engine, root);
    }
  }

  const items = [...all.values()].map((rec) => ({
    query: rec.query,
    engines: [...rec.engines],
    roots: [...rec.roots],
    intent: classifyIntent(rec.query),
  }));

  // Порядок: сначала транзакционные и коммерческие (готовы дать заявку),
  // потом информационные (нужны статьи блога).
  const rank = { transactional: 0, commercial: 1, informational: 2, navigational: 3 };
  items.sort((a, b) => rank[a.intent] - rank[b.intent] || a.query.localeCompare(b.query, 'ru'));

  return items;
}

async function main() {
  const outArg = process.argv.indexOf('--out');
  const outPath = resolve(
    process.cwd(),
    outArg > -1 ? process.argv[outArg + 1] : 'docs/semantics/keywords.json',
  );

  const result = {
    generatedAt: new Date().toISOString().slice(0, 10),
    method:
      'Яндекс suggest + Google suggest + alphabet expand. Частотность — по hh.ru (вакансии, РФ) и Google Trends (0-100). Wordstat/Keys.so требуют оплаченного доступа.',
    clusters: [],
  };

  for (const cluster of CLUSTERS) {
    process.stderr.write(`[collect] ${cluster.id} ...\n`);
    const items = await collectCluster(cluster);
    result.clusters.push({
      id: cluster.id,
      num: cluster.num,
      title: cluster.title,
      roots: cluster.roots,
      count: items.length,
      byIntent: items.reduce((acc, i) => {
        acc[i.intent] = (acc[i.intent] || 0) + 1;
        return acc;
      }, {}),
      items,
    });
    process.stderr.write(`[collect] ${cluster.id}: ${items.length}\n`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf-8');

  const total = result.clusters.reduce((s, c) => s + c.count, 0);
  process.stderr.write(`\nВсего: ${total} запросов → ${outPath}\n`);
  for (const c of result.clusters) {
    process.stderr.write(`  ${c.num} ${c.id}: ${c.count} (${JSON.stringify(c.byIntent)})\n`);
  }
}

await main();

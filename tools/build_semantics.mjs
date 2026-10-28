/**
 * Сборка финального семантического ядра из трёх источников.
 *
 * Вход:
 *   docs/semantics/keywords.json     — ядро из suggest (1491 запрос, интент, движки)
 *   docs/semantics/hh_vacancies.json  — замер hh.ru (311 запрос → число вакансий)
 *   docs/semantics/trends.json        — Google Trends (60 корней → индекс 0-100)
 *
 * Выход:
 *   docs/semantics/semantics.json     — кластеризованное ядро (SSoT)
 *   docs/semantics/SUMMARY.md         — сводка для humans
 *
 * Запуск: node tools/build_semantics.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const read = (p) => JSON.parse(readFileSync(resolve(process.cwd(), p), 'utf-8'));

const kw = read('docs/semantics/keywords.json');
const hh = read('docs/semantics/hh_vacancies.json');
const tr = read('docs/semantics/trends.json');

// Частотность по hh.ru: число вакансий (объём спроса рынка труда).
const vac = new Map();
for (const i of hh.items) vac.set(i.query.toLowerCase(), i.vacancies);

// Google Trends: индекс по корням.
const trend = new Map();
for (const i of tr.items) trend.set(i.query.toLowerCase(), i);

// Сводка по кластеру.
const clusters = kw.clusters.map((c) => {
  const roots = c.roots.map((root) => {
    const key = root.toLowerCase();
    const t = trend.get(key);
    return {
      query: root,
      vacancies: vac.get(key) ?? null,
      trendsAvg: t ? t.avg : null,
      trendsMax: t ? t.max : null,
    };
  });

  const measured = roots.filter((r) => r.vacancies !== null);
  // Сумма по корням перекрывается (корни вложены друг в друга) — поэтому
  // отдельной метрикой идёт лучший корень: максимум по одному запросу.
  const totalVac = measured.reduce((s, r) => s + r.vacancies, 0);
  const best = measured.length
    ? measured.reduce((a, b) => (b.vacancies > a.vacancies ? b : a))
    : null;

  // Топ-коммерческие: сортировка по вакансиям, затем по длине запроса (короче = точнее).
  const commercial = c.items
    .filter((i) => i.intent === 'commercial' || i.intent === 'transactional')
    .map((i) => ({
      query: i.query,
      intent: i.intent,
      vacancies: vac.get(i.query.toLowerCase()) ?? null,
      engines: i.engines,
    }))
    .sort((a, b) => (b.vacancies ?? -1) - (a.vacancies ?? -1) || a.query.length - b.query.length);

  // Инфо-темы для блога (задача 2.5).
  const informational = c.items
    .filter((i) => i.intent === 'informational')
    .map((i) => ({ query: i.query, vacancies: vac.get(i.query.toLowerCase()) ?? null }))
    .sort((a, b) => (b.vacancies ?? -1) - (a.vacancies ?? -1));

  return {
    id: c.id,
    num: c.num,
    title: c.title,
    count: c.count,
    byIntent: c.byIntent,
    totals: {
      queries: c.count,
      vacanciesMeasured: totalVac,
      bestRoot: best ? { query: best.query, vacancies: best.vacancies } : null,
      rootsMeasured: measured.length,
      rootsTotal: roots.length,
    },
    roots,
    topCommercial: commercial.slice(0, 30),
    informationalTopics: informational.slice(0, 25),
    items: c.items.map((i) => ({
      query: i.query,
      intent: i.intent,
      engines: i.engines,
      vacancies: vac.get(i.query.toLowerCase()) ?? null,
    })),
  };
});

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  method: {
    collection:
      'Яндекс suggest + Google suggest + alphabet expand (корень + буква по алфавиту). Фильтры: отсев брендов/медиа/гео, whitelist латиницы, обязательный маркер намерения, хвост после корня ≤ 4 слов.',
    frequency:
      'hh.ru — число вакансий по запросу, вся Россия (area=113). Показывает объём спроса рынка труда на навык, а не поисковые показы.',
    trends:
      'Google Trends — индекс интереса 0-100 за 12 месяцев, нормализован внутри батча сравнения (≤5 запросов). Сопоставим только внутри батча.',
    limitations: [
      'Wordstat и Keys.so недоступны: оба требуют оплаченного доступа. Числовых поисковых показов в артефакте нет.',
      'Частотность hh.ru — прокси-метрика (вакансии), а не реальные показы в поиске.',
      'Индекс Google Trends нормализован внутри батча: сравнивать можно только внутри кластера.',
      'Сбор выполнен 28.10.2026; suggest-выдача меняется — показатели стоит перезамерить через 3-6 месяцев.',
    ],
  },
  summary: {
    totalQueries: clusters.reduce((s, c) => s + c.count, 0),
    totalMeasured: clusters.reduce((s, c) => s + c.totals.vacanciesMeasured, 0),
    byCluster: clusters.map((c) => ({
      num: c.num,
      id: c.id,
      title: c.title,
      queries: c.count,
      vacancies: c.totals.vacanciesMeasured,
      bestRoot: c.totals.bestRoot?.query ?? null,
      bestRootVacancies: c.totals.bestRoot?.vacancies ?? 0,
    })),
  },
  clusters,
};

mkdirSync(resolve(process.cwd(), 'docs/semantics'), { recursive: true });
writeFileSync(
  resolve(process.cwd(), 'docs/semantics/semantics.json'),
  JSON.stringify(out, null, 2) + '\n',
  'utf-8',
);

// Markdown-сводка.
const md = [];
md.push('# Семантическое ядро AI-Traffic PRO');
md.push('');
md.push(`Собрано ${out.generatedAt}. Задача 2.1 (ROADMAP).`);
md.push('');
md.push('## Метод');
md.push('');
md.push('- **Сбор формулировок:** Яндекс suggest + Google suggest + alphabet expand.');
md.push('- **Частотность:** hh.ru — число вакансий по запросу (вся Россия, area=113).');
md.push('- **Индекс интереса:** Google Trends, 0–100 за 12 месяцев, нормализован внутри батча.');
md.push('');
md.push(
  '> Wordstat и Keys.so недоступны (требуют оплаченного доступа) — числовых поисковых показов в ядре нет.',
);
md.push('> Частотность hh.ru — прокси-метрика: объём спроса рынка труда, а не показы в поиске.');
md.push('');
md.push('## Сводка по услугам');
md.push('');
md.push('| № | Услуга | Запросов | Лучший корень | Вакансий hh.ru |');
md.push('|---|---|---:|---|---:|');
for (const c of out.summary.byCluster) {
  md.push(
    `| ${c.num} | ${c.title} | ${c.queries} | ${c.bestRoot ?? '—'} | ${c.bestRootVacancies.toLocaleString('ru-RU')} |`,
  );
}
md.push('');
md.push(
  `Всего запросов в ядре: **${out.summary.totalQueries}** (критерий задачи 2.1 — ≥150 на кластер, 6 кластеров).`,
);
md.push('');
md.push(
  '> Колонка «лучший корень» — максимум по одному запросу в кластере. Корни вложены друг в друга («интернет-магазин» ⊃ «разработка интернет-магазина»), поэтому сумма по всем корням завышена и как объём спроса не годится.',
);
md.push('');

for (const c of clusters) {
  md.push(`## ${c.num} · ${c.title}`);
  md.push('');
  md.push(
    `Запросов: ${c.count} · коммерческих: ${c.byIntent.commercial ?? 0} · информационных: ${c.byIntent.informational ?? 0} · транзакционных: ${c.byIntent.transactional ?? 0}`,
  );
  md.push('');
  md.push('### Корни (спрос)');
  md.push('');
  md.push('| Запрос | Вакансий hh.ru | Trends avg | Trends max |');
  md.push('|---|---:|---:|---:|');
  for (const r of c.roots) {
    md.push(
      `| ${r.query} | ${r.vacancies ?? '—'} | ${r.trendsAvg ?? '—'} | ${r.trendsMax ?? '—'} |`,
    );
  }
  md.push('');
  md.push('### Топ коммерческих запросов');
  md.push('');
  md.push('| Запрос | Интент | Вакансий |');
  md.push('|---|---|---:|');
  for (const q of c.topCommercial.slice(0, 15)) {
    md.push(`| ${q.query} | ${q.intent} | ${q.vacancies ?? '—'} |`);
  }
  md.push('');
  if (c.informationalTopics.length) {
    md.push('### Инфо-темы для блога');
    md.push('');
    md.push('| Запрос | Вакансий |');
    md.push('|---|---:|');
    for (const q of c.informationalTopics.slice(0, 12)) {
      md.push(`| ${q.query} | ${q.vacancies ?? '—'} |`);
    }
    md.push('');
  }
}

md.push('## Ограничения');
md.push('');
for (const l of out.method.limitations) md.push(`- ${l}`);
md.push('');
md.push('## Файлы');
md.push('');
md.push('- `semantics.json` — ядро (кластеры, запросы, интент, частотность) — **SSoT**');
md.push('- `keywords.json` — сырой сбор suggest (1491 запрос)');
md.push('- `hh_vacancies.json` — сырой замер hh.ru (311 запрос)');
md.push('- `trends.json` — сырой замер Google Trends (60 корней)');
md.push('- `to_measure.json` — список запросов, отобранных к замеру');
md.push('');

writeFileSync(resolve(process.cwd(), 'docs/semantics/SUMMARY.md'), md.join('\n'), 'utf-8');

// Форматируем markdown через prettier (тот же конфиг, что и у репозитория) —
// иначе сгенерированная сводка расходится с общим стилем.
try {
  const prettier = await import('prettier');
  const summaryPath = resolve(process.cwd(), 'docs/semantics/SUMMARY.md');
  const opts = await prettier.resolveConfig(summaryPath);
  const formatted = await prettier.format(md.join('\n'), { ...opts, parser: 'markdown' });
  writeFileSync(summaryPath, formatted, 'utf-8');
} catch (err) {
  process.stderr.write(`[build] prettier не применился: ${err.message}\n`);
}

process.stderr.write(
  `semantics.json: ${out.summary.totalQueries} запросов, ${out.summary.totalMeasured} вакансий\n`,
);
for (const c of out.summary.byCluster) {
  process.stderr.write(
    `  ${c.num} ${c.id}: ${c.queries} запросов, ${c.vacancies.toLocaleString('ru-RU')} вакансий\n`,
  );
}

/**
 * Подготовка списка запросов к замеру частотности.
 *
 * Берём не всё ядро (1491 запрос — замер часовой), а:
 *   - все корни кластеров (то, что реально ищут целиком)
 *   - топ-N коммерческих/транзакционных запросов каждого кластера
 *     (это запросы, которые ведут к заявке — их и надо продвигать в первую очередь)
 *
 * Вывод: docs/semantics/to_measure.json
 * Запуск: node tools/prepare_measure.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRC = resolve(process.cwd(), 'docs/semantics/keywords.json');
const OUT = resolve(process.cwd(), 'docs/semantics/to_measure.json');
const TOP_PER_CLUSTER = 22;

const data = JSON.parse((await import('node:fs')).readFileSync(SRC, 'utf-8'));

const targets = new Map(); // query → { cluster, intent, roots, engines }

for (const cluster of data.clusters) {
  // 1. Корни — частотность целиком.
  for (const root of cluster.roots) {
    const key = root.toLowerCase();
    if (!targets.has(key)) {
      targets.set(key, {
        query: root,
        cluster: cluster.id,
        clusterNum: cluster.num,
        intent: 'root',
        roots: [root],
        engines: [],
      });
    }
  }

  // 2. Топ коммерческих и транзакционных запросов.
  const ranked = cluster.items
    .filter((i) => i.intent === 'commercial' || i.intent === 'transactional')
    .slice(0, TOP_PER_CLUSTER);

  for (const item of ranked) {
    const key = item.query.toLowerCase();
    if (targets.has(key)) continue;
    targets.set(key, {
      query: item.query,
      cluster: cluster.id,
      clusterNum: cluster.num,
      intent: item.intent,
      roots: item.roots,
      engines: item.engines,
    });
  }
}

const list = [...targets.values()];

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), targets: list }, null, 2) +
    '\n',
  'utf-8',
);

process.stderr.write(`К замеру: ${list.length} запросов → ${OUT}\n`);
const byCluster = list.reduce((acc, t) => {
  acc[t.cluster] = (acc[t.cluster] || 0) + 1;
  return acc;
}, {});
for (const [k, v] of Object.entries(byCluster)) process.stderr.write(`  ${k}: ${v}\n`);

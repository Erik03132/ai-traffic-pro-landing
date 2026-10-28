/**
 * Интеграционный тест HTTP-сервера API.
 *
 * Запуск: node --test server/server.test.js
 * Зависимостей нет.
 *
 * Зачем он нужен: модульные тесты проверяют чистые функции, а HTTP-сервер
 * запускается целиком. Рефакторинг 28.10.2026 вырезал `applyCors` из
 * server.js — и сервер падал с `ReferenceError` на КАЖДОМ запросе, включая
 * health. Модульные тесты этого не видели: они не поднимают сервер.
 *
 * Здесь сервер поднимается как отдельный процесс на свободном порту,
 * и проверяется то, что видит клиент: коды ответов, заголовки CORS,
 * валидация заявки, ответ по базе знаний.
 *
 * Заявки с валидными данными здесь НЕ отправляются — тест не должен
 * писать лиды и слать сообщения в Telegram.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.js');
const ORIGIN = 'https://ai-traffic-pro.ru';
const ALLOWED_ORIGINS = `${ORIGIN},https://www.ai-traffic-pro.ru`;

/** Свободный порт: иначе параллельный прогон упадёт на EADDRINUSE. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Поднимает сервер и ждёт готовности.
 * @returns {Promise<{base: string, stop: () => Promise<void>}>}
 */
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      ALLOWED_ORIGINS,
      // Telegram и LLM выключены намеренно: тест не должен ни слать
      // сообщения, ни ходить во внешние сервисы.
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_CHAT_ID: '',
      LLM_BASE_URL: '',
      LLM_MODEL: '',
      LLM_FALLBACK_BASE_URL: '',
      LLM_FALLBACK_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  // Ждём строку старта — значит сервер слушает порт.
  await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      reject(new Error(`Сервер не поднялся за 10 с. stderr: ${stderr.join('')}`));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      if (out.includes('AI-Traffic PRO API')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Сервер завершился с кодом ${code}. stderr: ${stderr.join('')}`));
    });
  });

  return {
    base: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
      }),
  };
}

/** Запускает сервер один раз на весь файл — подъём стоит ~200 мс. */
let ctx;
test.before(async () => {
  ctx = await startServer();
});
test.after(async () => {
  await ctx?.stop();
});

test('GET /api/health отвечает 200 и подтверждает настройку Telegram', async () => {
  const res = await fetch(`${ctx.base}/api/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.telegram, false, 'Telegram выключен в тесте намеренно');
});

test('OPTIONS отдаёт CORS-заголовки для разрешённого origin', async () => {
  // Именно этот маршрут ловил баг с потерянным applyCors: функция
  // вызывалась до проверки метода, и её отсутствие роняло сервер.
  const res = await fetch(`${ctx.base}/api/chat/`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(res.headers.get('vary'), 'Origin');
});

test('чужой origin не получает CORS-заголовков', async () => {
  const res = await fetch(`${ctx.base}/api/chat/`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'сколько стоит' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('POST /api/chat отвечает по базе знаний без внешнего LLM', async () => {
  const res = await fetch(`${ctx.base}/api/chat/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'сколько стоит лендинг' }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.source, 'knowledge');
  assert.match(data.reply, /по запросу/);
});

test('POST /api/chat с пустым сообщением → 400', async () => {
  const res = await fetch(`${ctx.base}/api/chat/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '   ' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/lead с невалидными данными → 400 и список ошибок', async () => {
  const res = await fetch(`${ctx.base}/api/lead/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'И', contact: '1', service: '', consent: false }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.ok, false);
  assert.ok(data.errors.includes('consent'), 'требуется согласие на обработку ПДн');
});

test('несуществующий путь → 404', async () => {
  const res = await fetch(`${ctx.base}/nope/`);
  assert.equal(res.status, 404);
});

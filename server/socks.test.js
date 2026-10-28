/**
 * Тест SOCKS5-клиента: поднимаем локальный SOCKS5-сервер и проверяем,
 * что туннель до HTTPS-хоста работает (TLS-handshake через туннель).
 *
 * Запуск: node server/socks.test.js
 * Зависимостей нет — SOCKS5-сервер внутри теста тоже на чистом Node.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { parseProxyUrl, socks5Connect } from './socks.js';

/** Минимальный SOCKS5-сервер: поддерживает CONNECT и без аутентификации. */
function startSocksServer({ requireAuth = false, user = '', pass = '' } = {}) {
  const server = net.createServer((client) => {
    let step = 0;
    let buffer = Buffer.alloc(0);

    const send = (buf) => client.write(buf);

    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (step === 0) {
        // Greeting: ver, nmethods, methods...
        const n = buffer[1];
        const methods = buffer.subarray(2, 2 + n);
        buffer = buffer.subarray(2 + n);
        if (requireAuth) {
          assert.ok(methods.includes(0x02), 'клиент должен предлагать user/pass');
          send(Buffer.from([0x05, 0x02]));
          step = 1;
        } else {
          assert.ok(methods.includes(0x00), 'клиент должен предлагать no-auth');
          send(Buffer.from([0x05, 0x00]));
          step = 2;
        }
        return;
      }

      if (step === 1) {
        // Auth: ver, ulen, user, plen, pass
        const ulen = buffer[1];
        const plen = buffer[2 + ulen];
        const gotUser = buffer.subarray(2, 2 + ulen).toString('utf8');
        const gotPass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        buffer = buffer.subarray(3 + ulen + plen);
        assert.equal(gotUser, user, 'логин');
        assert.equal(gotPass, pass, 'пароль');
        send(Buffer.from([0x01, 0x00]));
        step = 2;
        return;
      }

      if (step === 2) {
        // CONNECT: ver, cmd, rsv, atyp, host..., port
        const atyp = buffer[3];
        let host;
        let offset;
        if (atyp === 0x03) {
          const len = buffer[4];
          host = buffer.subarray(5, 5 + len).toString('utf8');
          offset = 5 + len;
        } else {
          host = buffer.subarray(4, 8).join('.');
          offset = 8;
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);

        const upstream = net.connect(port, host, () => {
          // Ответ: ver, rep, rsv, atyp=IPv4, 0.0.0.0, port
          send(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        step = 3;
      }
    });

    client.on('error', () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ── 1. Разбор URL прокси ─────────────────────────────────────────────── */
test('parseProxyUrl: без логина', () => {
  const p = parseProxyUrl('socks5h://1.2.3.4:1080');
  assert.equal(p.host, '1.2.3.4');
  assert.equal(p.port, 1080);
  assert.equal(p.user, '');
});

test('parseProxyUrl: с логином и паролем', () => {
  const p = parseProxyUrl('socks5h://user:pa%40ss@1.2.3.4:64469');
  assert.equal(p.host, '1.2.3.4');
  assert.equal(p.port, 64469);
  assert.equal(p.user, 'user');
  assert.equal(p.pass, 'pa@ss', 'пароль декодируется');
});

test('parseProxyUrl: пустая строка → null', () => {
  assert.equal(parseProxyUrl(''), null);
});

/* ── 2. Туннель до локального TLS-сервера ────────────────────────────── */
test('SOCKS5: CONNECT до HTTPS-сервера работает', async () => {
  // Поднимаем HTTPS-сервер с самоподписанным сертификатом (генерируем openssl).
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socks-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      path.join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );

  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(path.join(dir, 'key.pem')),
      cert: fs.readFileSync(path.join(dir, 'cert.pem')),
    },
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    },
  );
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  const httpsPort = httpsServer.address().port;

  const { server: socksServer, port: socksPort } = await startSocksServer();

  const socket = await socks5Connect({
    proxy: { host: '127.0.0.1', port: socksPort, user: '', pass: '' },
    targetHost: '127.0.0.1',
    targetPort: httpsPort,
  });

  const secure = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false });
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });

  secure.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  const chunks = [];
  await new Promise((resolve) => {
    secure.on('data', (c) => chunks.push(c));
    secure.on('end', resolve);
    secure.on('close', resolve);
    setTimeout(resolve, 3000);
  });
  const text = Buffer.concat(chunks).toString('utf-8');
  assert.match(text, /^HTTP\/1\.1 200/, `ответ через туннель, получено: ${text.slice(0, 120)}`);
  assert.match(text, /ok/, 'тело ответа');

  secure.destroy();
  socksServer.close();
  httpsServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── 3. Аутентификация user/pass ──────────────────────────────────────── */
test('SOCKS5: аутентификация user/pass', async () => {
  // Цель CONNECT — живой TCP-сервер, иначе прокси закроет соединение.
  const target = net.createServer((c) => c.on('error', () => {}));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  const { server, port } = await startSocksServer({ requireAuth: true, user: 'u', pass: 'p' });
  const socket = await socks5Connect({
    proxy: { host: '127.0.0.1', port, user: 'u', pass: 'p' },
    targetHost: '127.0.0.1',
    targetPort,
  });
  assert.ok(socket, 'туннель установлен');
  socket.destroy();
  server.close();
  target.close();
});

/* ── 4. Ошибка: прокси отклоняет CONNECT ─────────────────────────────── */
test('SOCKS5: невалидный ответ прокси → повтор подключения', async () => {
  // Прокси-мусор: на первое соединение отвечает мусором, на второе — как надо.
  let connections = 0;
  const server = net.createServer((client) => {
    connections++;
    if (connections === 1) {
      // Мусор вместо SOCKS5-рукопожатия (как на shared-прокси).
      client.write(Buffer.from([0x00, 0x5b, 0xfb, 0xd5, 0xac, 0x78]));
      return;
    }
    client.once('data', () => {
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', () => {
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
    });
    client.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const socket = await socks5Connect({
    proxy: { host: '127.0.0.1', port, user: '', pass: '' },
    targetHost: 'example.com',
    targetPort: 443,
    attempts: 4,
  });
  assert.ok(socket, 'туннель установлен после повтора');
  assert.ok(connections >= 2, `было ${connections} попыток — ожидался повтор`);
  socket.destroy();
  server.close();
});

test('SOCKS5: все попытки исчерпаны → понятная ошибка', async () => {
  const server = net.createServer((client) => {
    client.write(Buffer.from([0x00, 0x5b, 0xfb, 0xd5]));
    client.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await assert.rejects(
    () =>
      socks5Connect({
        proxy: { host: '127.0.0.1', port, user: '', pass: '' },
        targetHost: 'example.com',
        targetPort: 443,
        attempts: 2,
      }),
    /не по протоколу/,
  );
  server.close();
});

test('SOCKS5: отказ CONNECT даёт понятную ошибку', async () => {
  const server = net.createServer((client) => {
    client.once('data', () => {
      // Отвечаем: no-auth, затем REP=0x01 (general failure)
      client.write(Buffer.from([0x05, 0x00]));
      client.once('data', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
    });
    client.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await assert.rejects(
    () =>
      socks5Connect({
        proxy: { host: '127.0.0.1', port, user: '', pass: '' },
        targetHost: 'example.com',
        targetPort: 443,
      }),
    /отклонил CONNECT/,
  );
  server.close();
});

/* ── Прогон ───────────────────────────────────────────────────────────── */
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`✓ ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${t.name}\n  ${e.message}`);
  }
}
console.log(failed ? `\nПровалено: ${failed}` : '\nВсе тесты прошли');
process.exit(failed ? 1 : 0);

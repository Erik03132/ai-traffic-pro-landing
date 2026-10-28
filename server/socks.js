/**
 * Минимальный SOCKS5-клиент без зависимостей.
 *
 * Зачем: `fetch` в Node не умеет ходить через SOCKS5, а внешние LLM-провайдеры
 * из РФ доступны только через прокси (ADR-002). Варианты были:
 *   - apt-пакет socat + undici ProxyAgent — внешние зависимости и сервис;
 *   - npm-пакет socks-proxy-agent — лишняя зависимость в «zero-dependency» сервере;
 *   - свой клиент — ~120 строк, ничего лишнего.
 *
 * Реализован только сценарий «UDP не нужен, CONNECT по доменному имени»:
 *   клиент → прокси: SOCKS5 handshake (без аутентификации либо user/pass)
 *   клиент → прокси: CONNECT target-host:443
 *   далее — обычный TLS поверх установленного сокета.
 */
import net from 'node:net';

/** Разбирает `socks5h://user:pass@host:port`. */
export function parseProxyUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  const m = raw.match(/^socks5h?:\/\/(?:([^:@/]+)(?::([^@/]*))?@)?([^:/]+)(?::(\d+))?/i);
  if (!m) throw new Error(`не разобран прокси: ${raw}`);
  return {
    user: m[1] ? decodeURIComponent(m[1]) : '',
    pass: m[2] ? decodeURIComponent(m[2]) : '',
    host: m[3],
    port: m[4] ? Number(m[4]) : 1080,
  };
}

/**
 * Буферизованный ридер по сокету.
 *
 * Важно: данные приходят блоками, и блок может быть длиннее, чем запрошено.
 * Лишние байты нельзя выбрасывать — иначе следующий ответ придёт «обрезанным».
 * Поэтому остаток блока хранится в буфере до следующего чтения.
 */
class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#flush();
    });
    socket.on('error', (e) => {
      this.error = e;
      this.#flush();
    });
    socket.on('close', () => {
      this.error = this.error ?? new Error('SOCKS5: соединение закрыто прокси');
      this.#flush();
    });
  }

  #flush() {
    if (!this.waiter) return;
    if (this.error) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(this.error);
      return;
    }
    if (this.buffer.length >= this.waiter.need) {
      const { need, resolve } = this.waiter;
      this.waiter = null;
      const chunk = this.buffer.subarray(0, need);
      this.buffer = this.buffer.subarray(need);
      resolve(chunk);
    }
  }

  /** Читает ровно `n` байт (с учётом буфера). */
  read(n) {
    if (this.error) return Promise.reject(this.error);
    if (this.buffer.length >= n) {
      const chunk = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return Promise.resolve(chunk);
    }
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject };
    });
  }
}

/**
 * Одна попытка установить SOCKS5-туннель до `targetHost:targetPort`.
 * Возвращает готовый сокет, в который можно писать TLS-байты.
 */
function socks5ConnectOnce({ proxy, targetHost, targetPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const reader = new SocketReader(socket);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error('SOCKS5: таймаут')), timeoutMs);

    socket.once('error', fail);

    socket.on('connect', async () => {
      try {
        // 1. Приветствие. Метод 0x00 — без аутентификации,
        //    0x02 — user/pass (RFC 1929).
        const greeting = proxy.user
          ? Buffer.from([0x05, 0x01, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]);
        socket.write(greeting);

        const [ver, method] = await reader.read(2);
        if (ver !== 0x05) {
          // Прокси ответил не по протоколу SOCKS5. На shared-прокси такое
          // случается на части соединений (балансировщик отдаёт мусор) —
          // лечится повторным подключением, а не отказом.
          throw new Error(
            `SOCKS5: прокси ответил не по протоколу (версия ${ver}, метод ${method})`,
          );
        }
        if (method === 0x02) {
          if (!proxy.user) throw new Error('SOCKS5: прокси требует логин, а он не задан');
          const u = Buffer.from(proxy.user, 'utf8');
          const p = Buffer.from(proxy.pass || '', 'utf8');
          socket.write(
            Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]),
          );
          const authRes = await reader.read(2);
          if (authRes[1] !== 0x00) throw new Error('SOCKS5: отказ аутентификации');
        } else if (method !== 0x00) {
          throw new Error(`SOCKS5: неподдерживаемый метод аутентификации ${method}`);
        }

        // 2. CONNECT. Домен отдаём как имя (0x03), чтобы DNS шёл на стороне прокси.
        const hostBuf = Buffer.from(targetHost, 'utf8');
        const request = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf,
          Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
        ]);
        socket.write(request);

        const head = await reader.read(4);
        if (head[0] !== 0x05) throw new Error('SOCKS5: неверный ответ');
        if (head[1] !== 0x00) {
          throw new Error(`SOCKS5: прокси отклонил CONNECT (код ${head[1]})`);
        }
        // 3. Читаем адрес в ответе — он нам не нужен, но его длина разная
        //    для IPv4 / домена / IPv6, и её надо вычитать из потока.
        const atyp = head[3];
        if (atyp === 0x01) await reader.read(4 + 2);
        else if (atyp === 0x04) await reader.read(16 + 2);
        else if (atyp === 0x03) {
          const len = await reader.read(1);
          await reader.read(len[0] + 2);
        } else {
          throw new Error(`SOCKS5: неизвестный тип адреса ${atyp}`);
        }

        clearTimeout(timer);
        if (settled) return;
        settled = true;
        socket.off('error', fail);
        resolve(socket);
      } catch (e) {
        clearTimeout(timer);
        fail(e);
      }
    });
  });
}

/**
 * Устанавливает SOCKS5-туннель до `targetHost:targetPort`.
 *
 * Прокси может на части соединений отвечать мусором вместо SOCKS5-рукопожатия
 * (наблюдается на shared-прокси: примерно половина соединений). Поэтому делаем
 * несколько попыток: невалидный ответ — не финальная ошибка, а повод
 * переподключиться (прокси попадёт на другую ноду балансировщика).
 */
export async function socks5Connect({
  proxy,
  targetHost,
  targetPort,
  timeoutMs = 20000,
  attempts = 4,
}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await socks5ConnectOnce({ proxy, targetHost, targetPort, timeoutMs });
    } catch (e) {
      lastError = e;
      if (attempt < attempts) {
        // Пауза с нарастанием: даём прокси переключиться на другую ноду.
        await new Promise((r) => setTimeout(r, attempt * 250));
      }
    }
  }
  throw lastError;
}

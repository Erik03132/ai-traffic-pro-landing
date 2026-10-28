/**
 * Rate limit: защита от спама, окно в памяти процесса.
 *
 * Почему отдельный модуль, а не функция в server.js:
 * логика IP обязана быть покрыта тестом. Баг, который тут был (2026-10-28),
 * стоил живых заявок: за nginx `req.socket.remoteAddress` всегда
 * `::ffff:127.0.0.1`, поэтому счётчик был общим на всех посетителей сайта —
 * любой мог отрезать отправку заявок всем остальным на минуту.
 *
 * Зависимостей нет — чистый Node.
 */
import net from 'node:net';

/**
 * Реальный IP клиента.
 *
 * nginx прокидывает `X-Forwarded-For: $proxy_add_x_forwarded_for`, то есть
 * дописывает настоящий адрес соединения в КОНЕЦ цепочки. Клиент может
 * подделать свой заголовок, но подделать последний элемент не может —
 * поэтому берём именно последний, а не первый.
 *
 * Прямой доступ к порту 3001 снаружи закрыт (ufw DROP), сервер виден
 * только через nginx — значит заголовку можно доверять.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string} IP-адрес или 'unknown', если определить не удалось
 */
export function clientIpFrom(req) {
  const header = req.headers?.['x-forwarded-for'];
  if (typeof header === 'string' && header.length > 0) {
    // Цепочка вида "spoofed, 1.2.3.4" — последний элемент добавил nginx.
    const chain = header.split(',');
    const last = chain[chain.length - 1]?.trim();
    if (last && net.isIP(last)) return last;
  }

  const direct = req.socket?.remoteAddress;
  if (direct && net.isIP(direct)) return direct;

  return 'unknown';
}

/**
 * Счётчик запросов в скользящем окне, с раздельными баками по «назначению».
 *
 * Бакеты разведены намеренно: чат-виджет и форма заявки раньше делили один
 * счётчик — 10 сообщений в чате блокировали отправку формы.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs] окно, мс
 * @param {number} [options.max] сколько запросов на IP на окно
 * @param {number} [options.maxBuckets] потолок числа IP в памяти
 */
export function createRateLimiter({ windowMs = 60_000, max = 10, maxBuckets = 10_000 } = {}) {
  /** @type {Map<string, number[]>} ключ = `${bucket}:${ip}` */
  const hitsByKey = new Map();
  let lastPrune = Date.now();

  /** Удаляем ключи, у которых все отметки вне окна, и ключи сверх потолка. */
  function prune(now) {
    if (now - lastPrune < windowMs && hitsByKey.size < maxBuckets) return;
    lastPrune = now;
    for (const [key, hits] of hitsByKey) {
      if (hits.length === 0 || now - hits[hits.length - 1] >= windowMs) {
        hitsByKey.delete(key);
      }
    }
    // Если бакетов всё ещё больше потолка — режем самые старые.
    if (hitsByKey.size > maxBuckets) {
      const excess = hitsByKey.size - maxBuckets;
      let removed = 0;
      for (const key of hitsByKey.keys()) {
        hitsByKey.delete(key);
        if (++removed >= excess) break;
      }
    }
  }

  /**
   * @param {string} ip
   * @param {string} [bucket] назначение ('lead' | 'chat' | …)
   * @returns {boolean} true — запрос отклонён (лимит исчерпан)
   */
  function isRateLimited(ip, bucket = 'default') {
    const now = Date.now();
    prune(now);

    const key = `${bucket}:${ip}`;
    const hits = (hitsByKey.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      // Не продлеваем окно: заблокированный запрос не должен сдвигать
      // момент снятия ограничения.
      hitsByKey.set(key, hits);
      return true;
    }
    hits.push(now);
    hitsByKey.set(key, hits);
    return false;
  }

  /** Сброс счётчиков — используется в тестах. */
  function reset() {
    hitsByKey.clear();
    lastPrune = Date.now();
  }

  return { isRateLimited, reset };
}

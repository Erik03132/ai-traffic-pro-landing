/**
 * Отправка заявки: основной адрес → резервный адрес.
 *
 * Зачем: сайт лежит на GitHub Pages, API — на Cloudflare Worker. Заявка — это
 * деньги, и терять её из-за сетевого сбоя нельзя.
 *
 * Правила повтора намеренно строгие:
 *   - повтор делается ТОЛЬКО при сетевой ошибке (запрос не дошёл до сервера);
 *   - при 5xx повтора НЕТ: ответ сервера означает, что запрос мог дойти
 *     и заявка могла уйти в Telegram. Повтор = две заявки у клиента.
 *   - при 400/404/429 повтора нет по очевидным причинам.
 *
 * Если не сработало ни то, ни другое — вызывающий код показывает ссылку
 * в Telegram с готовым текстом заявки. Это финальный ручной путь, он
 * не зависит ни от какого сервера.
 */

export interface SubmitLeadOptions {
  /** Адрес основного API. */
  url: string;
  /** Резервный адрес API (другая инфраструктура). */
  fallbackUrl?: string;
  /** Тело запроса. */
  payload: Record<string, unknown>;
  /** Сколько попыток суммарно. По умолчанию 2. */
  attempts?: number;
  /** Пауза между попытками, мс. По умолчанию 700. */
  retryDelayMs?: number;
  /** Таймаут одной попытки, мс. По умолчанию 15000. */
  timeoutMs?: number;
  /** Подмена fetch — для тестов. */
  fetchImpl?: typeof fetch;
}

export interface SubmitLeadResult {
  /** Принял ли сервер заявку. */
  ok: boolean;
  /** HTTP-статус последнего ответа; 0 — сеть не ответила. */
  status: number;
  /** Сколько попыток сделано. */
  tries: number;
  /** Какой адрес использовался в последней попытке. */
  via: 'primary' | 'fallback' | 'none';
}

/** Ждёт указанное число миллисекунд. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Отправляет заявку на основной адрес, при сетевой ошибке — на резервный.
 *
 * @param options параметры отправки
 * @returns результат: принято ли, статус, число попыток, использованный адрес
 */
export async function submitLead(options: SubmitLeadOptions): Promise<SubmitLeadResult> {
  const {
    url,
    fallbackUrl,
    payload,
    attempts = 2,
    retryDelayMs = 700,
    timeoutMs = 15000,
    fetchImpl = fetch,
  } = options;

  // Адреса, которые пробуем по очереди. Дубликаты убираем.
  const targets: Array<{ url: string; via: 'primary' | 'fallback' }> = [{ url, via: 'primary' }];
  if (fallbackUrl && fallbackUrl !== url) {
    targets.push({ url: fallbackUrl, via: 'fallback' });
  }

  let status = 0;
  let tries = 0;
  let via: 'primary' | 'fallback' | 'none' = 'none';

  for (let i = 0; i < Math.min(attempts, targets.length); i++) {
    tries = i + 1;
    via = targets[i].via;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(targets[i].url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      status = response.status;

      if (response.ok) {
        return { ok: true, status, tries, via };
      }

      // Сервер ответил → адрес работает. Повтор не поможет и может
      // продублировать заявку. Прекращаем.
      return { ok: false, status, tries, via };
    } catch {
      // Сеть недоступна или истёк таймаут — запрос точно не дошёл.
      // Единственный безопасный случай для повтора.
      status = 0;
    }

    if (i < Math.min(attempts, targets.length) - 1) {
      await sleep(retryDelayMs);
    }
  }

  return { ok: false, status, tries, via };
}

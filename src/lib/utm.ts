/**
 * UTM-метки перехода: запоминаем первый заход и держим до отправки формы.
 *
 * Зачем: Telegram, VK и Дзен не передают referrer. Единственный способ понять,
 * из какого канала пришёл человек, — метки в адресе. Яндекс.Метрика читает их
 * сама и строит отчёт «Метки UTM», но заявка уходит на сервер отдельным
 * запросом, уже без адресной строки: если метки не сохранить, в сообщении о
 * заявке канала не будет и в CRM он тоже не попадёт.
 *
 * Правило — first-touch: сохраняем метки первого захода и не перезаписываем их
 * при переходах внутри сайта. Иначе источник затрётся последней просмотренной
 * страницей, у которой меток нет.
 */

/** Ключ в sessionStorage. Хранится до закрытия вкладки. */
export const UTM_KEY = 'atp_utm';

export interface Utm {
  source?: string;
  campaign?: string;
  content?: string;
}

/** Соответствие параметров адреса и полей объекта. */
const FIELDS = {
  utm_source: 'source',
  utm_campaign: 'campaign',
  utm_content: 'content',
} as const;

/** Максимальная длина одного значения — защита от мусора в заявке. */
const MAX_LEN = 80;

/**
 * Разбирает метки из строки запроса (`?utm_source=telegram&...`).
 * Пустые значения отбрасываются, длинные — обрезаются.
 */
export function parseUtm(search: string): Utm {
  const params = new URLSearchParams(search);
  const utm: Utm = {};

  for (const [param, field] of Object.entries(FIELDS)) {
    const value = (params.get(param) ?? '').trim();
    if (value) utm[field] = value.slice(0, MAX_LEN);
  }

  return utm;
}

/** Читает сохранённые метки, не падая на недоступном хранилище. */
function readSaved(storage: Storage): Utm {
  try {
    const raw = storage.getItem(UTM_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const utm: Utm = {};
    for (const field of Object.values(FIELDS)) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === 'string' && value) utm[field] = value;
    }
    return utm;
  } catch {
    // Приватный режим Safari и запрет хранилища: работаем без запоминания.
    return {};
  }
}

/**
 * Запоминает метки первого захода и возвращает актуальные для сессии.
 * Если метки уже сохранены — возвращает их, новые игнорируются.
 */
export function rememberUtm(storage: Storage, search: string): Utm {
  const saved = readSaved(storage);
  if (Object.keys(saved).length > 0) return saved;

  const fresh = parseUtm(search);
  if (Object.keys(fresh).length === 0) return {};

  try {
    storage.setItem(UTM_KEY, JSON.stringify(fresh));
  } catch {
    // Хранилище недоступно — метки живут только до перезагрузки страницы.
  }

  return fresh;
}

/** Метки текущей сессии (без записи новых). */
export function currentUtm(storage: Storage): Utm {
  return readSaved(storage);
}
/**
 * Цели Яндекс.Метрики — одна точка вызова на весь сайт.
 *
 * Компоненты не знают, есть ли счётчик: если `PUBLIC_YM_COUNTER_ID` пуст
 * (dev, локальная сборка) или скрипт Метрики не загрузился, `reachGoal`
 * превращается в no-op и возвращает `false`. Поэтому вызовы безопасно
 * оставлять прямо в коде формы и виджета.
 *
 * ВАЖНО: идентификаторы ниже — контракт с интерфейсом Метрики. Цель в
 * счётчике должна называться ровно так же (`lead_submit`, `phone_click`,
 * `chat_open`, `scroll_75`), иначе события уйдут в никуда.
 */

/** Имена целей. Совпадают с целями, заведёнными в счётчике. */
export type Goal = 'lead_submit' | 'phone_click' | 'chat_open' | 'scroll_75';

type YmFn = (counterId: number, action: string, ...rest: unknown[]) => void;

declare global {
  interface Window {
    ym?: YmFn;
    /** Ставится инлайн-скриптом счётчика (см. `Analytics.astro`). */
    __ymCounterId?: number;
  }
}

const fired = new Set<Goal>();

/**
 * Отправить цель в Метрику.
 *
 * @param goal   имя цели из контракта выше.
 * @param params параметры события (уходят в `reachGoal` третьим аргументом).
 * @param once   `true` — отправить не больше одного раза за жизнь страницы.
 * @returns `true`, если событие реально отправлено.
 */
export function reachGoal(
  goal: Goal,
  params?: Record<string, unknown>,
  { once = false }: { once?: boolean } = {},
): boolean {
  if (once && fired.has(goal)) return false;

  const counterId = typeof window === 'undefined' ? undefined : window.__ymCounterId;
  const ym = typeof window === 'undefined' ? undefined : window.ym;
  if (!counterId || typeof ym !== 'function') return false;

  once && fired.add(goal);
  ym(counterId, 'reachGoal', goal, params);
  return true;
}

/** Сброс guard-множества. Нужен только тестам. */
export function __resetGoals(): void {
  fired.clear();
}

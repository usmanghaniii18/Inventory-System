/**
 * PHASE H — how long after a sale a return is still accepted.
 *
 * Configurable from Settings → Sales (persisted as
 * `settings.store_info.return_window_days`); the constant below is only the
 * fallback used when the store has never set one. It was previously a bare `7`
 * hardcoded in two separate places inside the returns server action, which is
 * what made "returns aren't accepted after a week" impossible to change without
 * a code edit. 0 (or less) disables the limit entirely.
 *
 * This lives in lib/ rather than in the returns server action so it stays a
 * plain, dependency-free module the unit tests can import.
 */
export const DEFAULT_RETURN_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** Read the configured return window, falling back to the default. */
export function returnWindowDays(storeInfo: Record<string, unknown> | null | undefined): number {
  const raw = storeInfo?.return_window_days;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RETURN_WINDOW_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_RETURN_WINDOW_DAYS;
}

/** True when a sale of this age is still inside the window (0 = no limit). */
export function isWithinReturnWindow(saleDate: Date | string, windowDays: number, now = Date.now()): boolean {
  if (windowDays <= 0) return true;
  const ageDays = (now - new Date(saleDate).getTime()) / DAY_MS;
  return ageDays <= windowDays;
}

// US stock market regular hours: the market-status source to use while the Data Streams key isn't authorized for the
// feed. Every node computes the same answer from the DON's clock. The session times and the exchange calendar come
// from the workflow config; only New York's daylight-saving rule (US federal law) is in code, because the CRE runtime
// has no Intl time-zone data.

export interface MarketHoursConfig {
  readonly open: string; // "HH:MM" New York time, e.g. "09:30"
  readonly close: string; // "HH:MM", e.g. "16:00"
  readonly earlyClose: string; // "HH:MM" on early-close days, e.g. "13:00"
  readonly holidays: readonly string[]; // "YYYY-MM-DD": the exchange is closed all day
  readonly earlyCloses: readonly string[]; // "YYYY-MM-DD": the session ends at `earlyClose`
}

const HOUR_MS = 3_600_000;

export function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`market hours: not HH:MM: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Day of month of the `nth` Sunday of `month` (0-based) in `year`. */
function nthSunday(year: number, month: number, nth: number): number {
  return 1 + ((7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7) + 7 * (nth - 1);
}

/** New York's UTC offset in hours at `ms`: −4 from the 2nd Sunday of March (2:00 EST) to the 1st Sunday of
 *  November (2:00 EDT), −5 otherwise. */
export function newYorkOffsetHours(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  const dstStart = Date.UTC(year, 2, nthSunday(year, 2, 2), 2 + 5);
  const dstEnd = Date.UTC(year, 10, nthSunday(year, 10, 1), 2 + 4);
  return ms >= dstStart && ms < dstEnd ? -4 : -5;
}

/** The New York calendar day ("YYYY-MM-DD"), weekday (0 = Sunday) and minute of the day at `ms`. */
export function newYorkTime(ms: number): { day: string; weekday: number; minute: number } {
  const local = new Date(ms + newYorkOffsetHours(ms) * HOUR_MS);
  return {
    day: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** Is the market in its regular session at `ms`: a weekday that isn't a holiday, between open and (early) close. */
export function isMarketOpen(ms: number, cfg: MarketHoursConfig): boolean {
  const { day, weekday, minute } = newYorkTime(ms);
  if (weekday === 0 || weekday === 6 || cfg.holidays.includes(day)) return false;
  const close = minutesOf(cfg.earlyCloses.includes(day) ? cfg.earlyClose : cfg.close);
  return minute >= minutesOf(cfg.open) && minute < close;
}

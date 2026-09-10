/**
 * Rax earnings — what the account's cards earned, per day.
 *
 * Backed by Real's own "Historical Earnings" data:
 *   /cardhistoricalearnings/calendar   → { day → rax earned that day }
 *   /cardhistoricalearnings?day=<day>  → that day's per-sport, per-card breakdown
 * Two calls, cached briefly in-process. (The per-card
 * /userpassearnings/... calendars would need one call per card and Real
 * 429s that burst — not used.)
 *
 * Day boundary: Real's own definition, Eastern time minus 7 hours
 * (`GetEasternNowDay` in the app bundle) — so 5:15am ET still reads as the
 * previous day, and the day flips at 07:00 ET.
 */

import { getEarningsCalendar, getEarningsDay, type EarningsDay } from "./real-api";

const CACHE_TTL = 5 * 60 * 1000;

/** Real's eastern day: ET wall clock shifted -7h, as YYYY-MM-DD. */
export function earningsDay(now: Date = new Date()): string {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  et.setHours(et.getHours() - 7);
  return ymd(et);
}

/** Clock used for the "rolls at 07:00 ET" note. */
export function etNow(now: Date = new Date()): { hour: number; minute: number } {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return { hour: et.getHours(), minute: et.getMinutes() };
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface RaxResponse {
  /** Real's eastern day the totals belong to. */
  day: string;
  /** Real's current eastern day (the "today" marker, independent of `day`). */
  today: string;
  /** Day breakdown (per sport, per card) for `day`. */
  detail: EarningsDay;
  /** Same as detail.total — Real's own day figure. */
  total: number;
  /** Day → rax earned, for the calendar view. */
  calendar: Record<string, number>;
  calendarTotal: number;
  bestDay: { day: string; total: number } | null;
  etHour: number;
  etMinute: number;
  rollover: string;
  cached: boolean;
}

type Entry = { at: number; calendar: Record<string, number> };
let calendarCache: Entry | null = null;
const dayCache = new Map<string, { at: number; detail: EarningsDay }>();

export async function loadEarningsCalendar(): Promise<Record<string, number>> {
  if (calendarCache && calendarCache.at > Date.now()) return calendarCache.calendar;
  const calendar = await getEarningsCalendar();
  calendarCache = { at: Date.now() + CACHE_TTL, calendar };
  return calendar;
}

export async function loadEarningsDay(day: string): Promise<EarningsDay> {
  const hit = dayCache.get(day);
  if (hit && hit.at > Date.now()) return hit.detail;
  const detail = await getEarningsDay(day);
  dayCache.set(day, { at: Date.now() + CACHE_TTL, detail });
  if (dayCache.size > 60) {
    for (const [k, v] of dayCache) if (v.at < Date.now()) dayCache.delete(k);
  }
  return detail;
}

/** Everything the Rax tab needs for one day (defaults to Real's current day). */
export async function buildRax(day?: string): Promise<RaxResponse> {
  const calendar = await loadEarningsCalendar();
  const today = earningsDay();
  const target = day ?? today;
  const detail = await loadEarningsDay(target);
  const clock = etNow();

  let bestDay: { day: string; total: number } | null = null;
  let calendarTotal = 0;
  for (const [d, v] of Object.entries(calendar)) {
    // Real's map carries values past today (season placeholders) — the
    // season-to-date figures only count days up to Real's current day.
    if (d > today) continue;
    calendarTotal += v;
    if (!bestDay || v > bestDay.total) bestDay = { day: d, total: v };
  }

  return {
    day: target,
    today,
    detail,
    // Real's calendar figure is authoritative for the day; the breakdown sum
    // can lag by a few rax while a day is still settling.
    total: calendar[target] ?? detail.total,
    calendar,
    calendarTotal,
    bestDay,
    etHour: clock.hour,
    etMinute: clock.minute,
    rollover: "07:00 ET",
    cached: false,
  };
}

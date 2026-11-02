import { TIMEZONE } from "./config.ts";

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hhmm: string; // HHMM
  weekday: number; // 0 = Sunday
}

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localParts(d: Date): LocalParts {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${p.hour}${p.minute}`,
    weekday: WEEKDAYS.indexOf(p.weekday!),
  };
}

/** Rome wall-clock time → instant. Handles DST by correcting with the offset at that instant. */
export function localToDate(date: string, hhmm: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const h = Number(hhmm.slice(0, 2));
  const mi = Number(hhmm.slice(2));
  const guess = Date.UTC(y!, m! - 1, d!, h, mi);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(t));
    const [py, pm, pd] = p.date.split("-").map(Number);
    const seen = Date.UTC(py!, pm! - 1, pd!, Number(p.hhmm.slice(0, 2)), Number(p.hhmm.slice(2)));
    t += guess - seen;
  }
  return new Date(t);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export const runIdOf = (date: string, hhmm: string) => `${date}-${hhmm}`;

export function parseRunId(runId: string): { date: string; hhmm: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})-(\d{4})$/.exec(runId);
  return m ? { date: m[1]!, hhmm: m[2]! } : null;
}

export const prettyRun = (runId: string) => {
  const p = parseRunId(runId);
  return p ? `${p.date} ${p.hhmm.slice(0, 2)}:${p.hhmm.slice(2)}` : runId;
};

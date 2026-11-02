import { MISSED_AFTER_MINUTES, SLOTS, type Slot } from "./config.ts";
import { addDays, localParts, localToDate, parseRunId, runIdOf, weekdayOf } from "./time.ts";

export function slotsOn(date: string): Slot[] {
  const wd = weekdayOf(date);
  const weekend = wd === 0 || wd === 6;
  return SLOTS.filter((s) => !weekend || s.weekend);
}

export function slotByHhmm(hhmm: string): Slot | undefined {
  return SLOTS.find((s) => s.hhmm === hhmm.replace(":", ""));
}

/** Every scheduled run id strictly after `from` and strictly before `to`. Scans at most 14 days. */
export function runIdsBetween(from: string, to: string): string[] {
  const a = parseRunId(from);
  const b = parseRunId(to);
  if (!a || !b || from >= to) return [];
  const out: string[] = [];
  for (let date = a.date, i = 0; date <= b.date && i < 14; date = addDays(date, 1), i++) {
    for (const s of slotsOn(date)) {
      const id = runIdOf(date, s.hhmm);
      if (id > from && id < to) out.push(id);
    }
  }
  return out;
}

export function nextRunAfter(runId: string): string | null {
  const p = parseRunId(runId);
  if (!p) return null;
  for (let date = p.date, i = 0; i < 8; date = addDays(date, 1), i++) {
    for (const s of slotsOn(date)) {
      const id = runIdOf(date, s.hhmm);
      if (id > runId) return id;
    }
  }
  return null;
}

/** Latest slot of today that has already started (for `once`). */
export function latestSlotToday(now: Date): Slot | undefined {
  const { date, hhmm } = localParts(now);
  return slotsOn(date).filter((s) => s.hhmm <= hhmm).at(-1);
}

/**
 * The slot the scheduler should run now, if any: started, not older than MISSED_AFTER_MINUTES,
 * and newer than the last baton.
 */
export function dueSlot(now: Date, lastRunId: string | null): { slot: Slot; runId: string } | null {
  const { date } = localParts(now);
  const s = latestSlotToday(now);
  if (!s) return null;
  const runId = runIdOf(date, s.hhmm);
  if (lastRunId && runId <= lastRunId) return null;
  const lateMin = (now.getTime() - localToDate(date, s.hhmm).getTime()) / 60_000;
  if (lateMin > MISSED_AFTER_MINUTES) return null;
  return { slot: s, runId };
}

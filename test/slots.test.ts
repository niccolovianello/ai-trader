import { describe, expect, test } from "bun:test";
import { acquireLock, releaseLock } from "../src/lock.ts";
import { dueSlot, nextRunAfter, runIdsBetween } from "../src/slots.ts";
import { localParts, localToDate } from "../src/time.ts";
import { deadPid, tempRoot } from "./helpers.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

describe("orari", () => {
  test("ora di Roma, anche a cavallo dell'ora legale", () => {
    expect(localToDate("2026-07-01", "1540").toISOString()).toBe("2026-07-01T13:40:00.000Z");
    expect(localToDate("2026-12-01", "1540").toISOString()).toBe("2026-12-01T14:40:00.000Z");
    expect(localParts(new Date("2026-10-05T13:40:00Z"))).toEqual({ date: "2026-10-05", hhmm: "1540", weekday: 1 });
  });

  test("nel weekend solo il briefing", () => {
    expect(runIdsBetween("2026-10-09-2140", "2026-10-12-0900")).toEqual(["2026-10-10-0900", "2026-10-11-0900"]);
    expect(nextRunAfter("2026-10-09-2140")).toBe("2026-10-10-0900");
  });

  test("lo scheduler lancia la sveglia dovuta, una volta sola", () => {
    const at = (hhmm: string) => localToDate("2026-10-05", hhmm);
    expect(dueSlot(at("0859"), null)).toBeNull();
    expect(dueSlot(at("0900"), null)?.runId).toBe("2026-10-05-0900");
    expect(dueSlot(at("0930"), "2026-10-05-0900")).toBeNull();
    expect(dueSlot(at("1541"), "2026-10-05-0900")?.runId).toBe("2026-10-05-1540");
  });

  test("una sveglia in ritardo di oltre 60 minuti non parte: sarà segnalata come saltata", () => {
    expect(dueSlot(localToDate("2026-10-05", "1645"), "2026-10-05-0900")).toBeNull();
  });
});

describe("lucchetto", () => {
  test("una sola sveglia alla volta", () => {
    const path = join(tempRoot(), "run.lock");
    const now = new Date();
    expect(acquireLock(path, { runId: "a", pid: process.pid, startedAt: now.toISOString() }, now).ok).toBe(true);
    expect(acquireLock(path, { runId: "b", pid: process.pid, startedAt: now.toISOString() }, now).ok).toBe(false);
    releaseLock(path);
    expect(acquireLock(path, { runId: "c", pid: process.pid, startedAt: now.toISOString() }, now).ok).toBe(true);
  });

  test("lock morto: lo prende uno solo, l'altro trova il lock vivo del primo", async () => {
    const path = join(tempRoot(), "run.lock");
    const now = new Date();
    writeFileSync(path, JSON.stringify({ runId: "morta", pid: await deadPid(), startedAt: now.toISOString() }));
    const a = acquireLock(path, { runId: "a", pid: process.pid, startedAt: now.toISOString() }, now);
    const b = acquireLock(path, { runId: "b", pid: process.pid, startedAt: now.toISOString() }, now);
    expect(a).toMatchObject({ ok: true, stale: { runId: "morta" } });
    expect(b.ok).toBe(false);
  });

  test("lock troppo vecchio (pid riciclato) vale come morto", () => {
    const path = join(tempRoot(), "run.lock");
    const now = new Date();
    writeFileSync(path, JSON.stringify({ runId: "vecchia", pid: process.pid, startedAt: new Date(now.getTime() - 3600_000).toISOString() }));
    expect(acquireLock(path, { runId: "a", pid: process.pid, startedAt: now.toISOString() }, now)).toMatchObject({ ok: true, stale: { runId: "vecchia" } });
  });
});

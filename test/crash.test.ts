// Real processes, real SIGKILL: the failures an unattended trader actually meets.
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBaton } from "../src/baton.ts";
import { FakeBroker } from "../src/broker/fake.ts";
import { makePaths, PROJECT_ROOT } from "../src/config.ts";
import { DAY, deadPid, spawnOnce, tempRoot } from "./helpers.ts";

const out = async (p: ReturnType<typeof spawnOnce>) => (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
const fakePaths = (root: string) => makePaths(root, true);
const orders = (root: string) => new FakeBroker(fakePaths(root).fakeBroker).read().orders;

describe("guasti veri", () => {
  test("morte a metà: kill -9 dopo il primo ordine → la sveglia dopo trova il lock, riconcilia, non ricompra", async () => {
    const root = tempRoot();
    const first = spawnOnce(root, ["--slot", "1540"], { FAKE_CRASH_AFTER_SUBMITS: "1" });
    await first.exited;
    expect(first.signalCode).toBe("SIGKILL");
    expect(orders(root)).toHaveLength(1);
    expect(existsSync(fakePaths(root).lock)).toBe(true);
    expect(readBaton(fakePaths(root).baton).baton).toBeNull();

    const second = spawnOnce(root, ["--slot", "1540"]);
    const text = await out(second);
    expect(await second.exited).toBe(0);
    expect(text).toContain(`Sveglia precedente interrotta (run ${DAY}-1540). Sul broker: comprato 20 SPY`);
    const ids = orders(root).map((o) => o.clientOrderId);
    expect(ids.sort()).toEqual([`${DAY}-1540-GLD-buy`, `${DAY}-1540-QQQ-buy`, `${DAY}-1540-SPY-buy`]);
    expect(existsSync(fakePaths(root).lock)).toBe(false);
  }, 30_000);

  test("doppio lancio a mezzo secondo di distanza → un solo giro, un ordine per titolo", async () => {
    const root = tempRoot();
    const env = { FAKE_BRAIN_DELAY_MS: "1500" };
    const a = spawnOnce(root, ["--slot", "1540"], env);
    await Bun.sleep(500);
    const b = spawnOnce(root, ["--slot", "1540"], env);
    const [ta, tb] = await Promise.all([out(a), out(b)]);
    await Promise.all([a.exited, b.exited]);
    expect(orders(root)).toHaveLength(3);
    expect((ta + tb).match(/▶ Sveglia/g)).toHaveLength(1);
  }, 30_000);

  test("due sveglie trovano insieme il lock di una sveglia morta → ne passa una sola", async () => {
    const root = tempRoot();
    const paths = fakePaths(root);
    FakeBroker.seed(paths.fakeBroker);
    writeFileSync(paths.lock, JSON.stringify({ runId: `${DAY}-0900`, pid: await deadPid(), startedAt: new Date().toISOString() }));
    const env = { FAKE_BRAIN_DELAY_MS: "1000" };
    const procs = [spawnOnce(root, ["--slot", "1540"], env), spawnOnce(root, ["--slot", "1540"], env)];
    const texts = await Promise.all(procs.map(out));
    await Promise.all(procs.map((p) => p.exited));
    const joined = texts.join("\n");
    expect(joined.match(/Sveglia precedente interrotta/g)).toHaveLength(2); // log line + notification, from one process
    expect(texts.filter((t) => t.includes("Sveglia precedente interrotta"))).toHaveLength(1);
    expect(orders(root)).toHaveLength(3);
  }, 30_000);

  test("testimone scritto a metà: kill -9 mentre salva → si legge il vecchio o il nuovo, mai mezzo", async () => {
    const root = tempRoot();
    const paths = fakePaths(root);
    const script = `
      import { writeBaton } from ${JSON.stringify(join(PROJECT_ROOT, "src/baton.ts"))};
      const big = "x".repeat(200_000);
      for (let i = 0; ; i++) writeBaton(${JSON.stringify(paths.baton)}, ${JSON.stringify(paths.history)}, {
        version: 1, runId: "2026-10-05-1540", slot: "1540", slotName: "apertura", runAt: "", status: "ok", brain: "finto",
        orders: [], rejected: [], reasoning: big + i, planNext: "p", equity: 1, dayPnl: 0, positions: [], alerts: [], nextRun: null });
    `;
    for (let round = 0; round < 3; round++) {
      const p = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
      await Bun.sleep(300 + round * 70);
      p.kill("SIGKILL");
      await p.exited;
      const r = readBaton(paths.baton);
      expect(r.corrupted).toBe(false);
      expect(r.baton?.runId).toBe("2026-10-05-1540");
    }
  }, 30_000);
});

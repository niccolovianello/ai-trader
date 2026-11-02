// bun run schedule [--fake] — stays on, checks the time every 30 s, runs the due wakeup as a fresh process.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, SCHEDULER_TICK_MS, STATUS_PORT } from "../config.ts";
import { assertPaperOnly, loadKeys, PaperOnlyError } from "../keys.ts";
import { buildStore, parseFlags, projectPaths } from "../runtime.ts";
import { dueSlot } from "../slots.ts";
import { startStatusPage } from "../statusPage.ts";

const flags = parseFlags(process.argv.slice(2));
const paths = projectPaths(flags);
mkdirSync(paths.state, { recursive: true });

const keys = await loadKeys(PROJECT_ROOT);
const store = buildStore(paths, keys, flags.fake);
if (!flags.fake) {
  try {
    assertPaperOnly(keys);
  } catch (e) {
    if (e instanceof PaperOnlyError) {
      console.error(`⛔ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    // A store hiccup (e.g. Firestore unreachable) skips this tick; it must not kill the scheduler.
    const due = dueSlot(new Date(), (await store.readBaton()).baton?.runId ?? null);
    if (!due) return;
    console.log(`[schedule ] ${new Date().toISOString()} lancio la sveglia ${due.runId} (${due.slot.name})`);
    const args = ["bun", join(PROJECT_ROOT, "src/cli/once.ts"), "--slot", due.slot.hhmm, ...(flags.fake ? ["--fake"] : [])];
    const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit", env: process.env });
    console.log(`[schedule ] sveglia ${due.runId} finita con codice ${await proc.exited}`);
  } catch (e) {
    console.error(`[schedule ] ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

startStatusPage(store, flags, STATUS_PORT);
console.log(`[schedule ] acceso${flags.fake ? " (finto)" : ""} · controllo ogni ${SCHEDULER_TICK_MS / 1000}s · pagina di stato http://localhost:${STATUS_PORT}`);
await tick();
setInterval(tick, SCHEDULER_TICK_MS);

// bun run once [--fake] [--slot 1540 | --due] [--force]
import { mkdirSync } from "node:fs";
import { PROJECT_ROOT, type Slot } from "../config.ts";
import { loadKeys, PaperOnlyError } from "../keys.ts";
import { buildRuntime, buildStore, parseFlags, projectPaths } from "../runtime.ts";
import { dueSlot, latestSlotToday, slotByHhmm } from "../slots.ts";
import { localParts, localToDate, runIdOf } from "../time.ts";
import { wakeup } from "../wakeup.ts";

const flags = parseFlags(process.argv.slice(2));
const realNow = process.env.FAKE_NOW && flags.fake ? new Date(process.env.FAKE_NOW) : new Date();
const today = localParts(realNow).date;
const paths = projectPaths(flags);
mkdirSync(paths.state, { recursive: true });

try {
  let slot: Slot | undefined;
  if (flags.due) {
    // Cron mode: fires often, runs the wakeup only when one is due and not done yet.
    const store = buildStore(paths, await loadKeys(PROJECT_ROOT), flags.fake);
    const due = dueSlot(realNow, (await store.readBaton()).baton?.runId ?? null);
    if (!due) {
      console.log(`[sveglia  ] nessuna sveglia dovuta adesso (${realNow.toISOString()})`);
      process.exit(0);
    }
    slot = due.slot;
  } else {
    slot = flags.slot ? slotByHhmm(flags.slot) : latestSlotToday(realNow);
    if (!slot) {
      console.error(flags.slot ? `Sveglia ${flags.slot} sconosciuta: usa 0900, 1540, 1830 o 2140.` : "Nessuna sveglia ancora dovuta oggi: aggiungi --slot 0900.");
      process.exit(2);
    }
  }

  // With the fake broker, --slot also moves the simulated clock to that time, so the market looks open at 15:40.
  const at = slot.hhmm;
  const now = flags.fake && flags.slot && !process.env.FAKE_NOW ? () => localToDate(today, at) : () => realNow;
  const rt = await buildRuntime(flags, runIdOf(today, slot.hhmm), now);
  const res = await wakeup({ ...rt, now }, { date: today, slot, force: flags.force });
  process.exit({ done: 0, "already-done": 0, busy: 3, error: 1 }[res.status]);
} catch (e) {
  console.error(`⛔ ${(e as Error).message}`);
  if (!(e instanceof PaperOnlyError) && process.env.DEBUG) console.error(e);
  process.exit(1);
}

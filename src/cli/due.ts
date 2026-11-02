// bun src/cli/due.ts — prints the slot due now (e.g. "1540"), or nothing. Used by the GitHub workflow
// to skip installing Claude Code on the many cron ticks where nothing is due.
import { appendFileSync } from "node:fs";
import { PROJECT_ROOT } from "../config.ts";
import { loadKeys } from "../keys.ts";
import { buildStore, parseFlags, projectPaths } from "../runtime.ts";
import { dueSlot } from "../slots.ts";

const flags = parseFlags(process.argv.slice(2));
try {
  const store = buildStore(projectPaths(flags), await loadKeys(PROJECT_ROOT), flags.fake);
  const due = dueSlot(new Date(), (await store.readBaton()).baton?.runId ?? null);
  console.log(due ? `sveglia dovuta: ${due.runId} (${due.slot.name})` : "nessuna sveglia dovuta adesso");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `slot=${due?.slot.hhmm ?? ""}\n`);
} catch (e) {
  console.error(`⛔ ${(e as Error).message}`);
  process.exit(1);
}

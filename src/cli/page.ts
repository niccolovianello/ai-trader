// bun run page [--fake] — only the status page on http://localhost:8787, no wakeups. Without --fake it reads
// baton, history and lock from Firestore, where the cloud trader writes them, so it is safe to run while the cloud trades.
import { PROJECT_ROOT, STATUS_PORT } from "../config.ts";
import { assertPaperOnly, loadKeys, PaperOnlyError } from "../keys.ts";
import { buildStore, parseFlags, projectPaths } from "../runtime.ts";
import { startStatusPage } from "../statusPage.ts";

const flags = parseFlags(process.argv.slice(2));
const keys = await loadKeys(PROJECT_ROOT);

if (!flags.fake) {
  if (!keys.FIREBASE_SERVICE_ACCOUNT) {
    console.error("⛔ FIREBASE_SERVICE_ACCOUNT è vuoto: mettilo in secrets.ts (lo stesso JSON del secret su GitHub) per leggere lo storico del cloud.");
    process.exit(1);
  }
  try {
    assertPaperOnly(keys);
  } catch (e) {
    if (e instanceof PaperOnlyError) {
      console.error(`⛔ ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  process.env.TRADER_STORE = "firestore";
}

const store = buildStore(projectPaths(flags), keys, flags.fake);
startStatusPage(store, flags, STATUS_PORT);
console.log(`[pagina   ] dati da ${store.kind} · http://localhost:${STATUS_PORT} · nessuna sveglia parte da qui`);

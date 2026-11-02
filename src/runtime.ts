import { AlpacaPaperBroker } from "./broker/alpaca.ts";
import { FakeBroker } from "./broker/fake.ts";
import type { Broker } from "./broker/types.ts";
import { makePaths, PROJECT_ROOT, type Paths } from "./config.ts";
import { assertPaperOnly, type Keys, loadKeys, secretValues } from "./keys.ts";
import { type Brain, ClaudeBrain, FakeBrain, FAKE_DECISION } from "./llm.ts";
import { type Logger, makeLogger } from "./log.ts";
import { ConsoleNotifier, type Notifier, TelegramNotifier } from "./notify.ts";
import { FileStore } from "./store/file.ts";
import { FirestoreStore } from "./store/firestore.ts";
import { FirestoreRest, parseServiceAccount } from "./store/firestoreRest.ts";
import type { Store } from "./store/types.ts";

export interface Flags {
  fake: boolean;
  force: boolean;
  due: boolean; // run only if a wakeup is due now (for cron), otherwise exit quietly
  slot?: string;
}

export function parseFlags(argv: string[]): Flags {
  const f: Flags = { fake: false, force: false, due: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fake") f.fake = true;
    else if (a === "--force") f.force = true;
    else if (a === "--due") f.due = true;
    else if (a === "--slot") f.slot = argv[++i]?.replace(":", "");
    else if (a?.startsWith("--slot=")) f.slot = a.slice(7).replace(":", "");
  }
  return f;
}

/** TRADER_ROOT lets tests point a subprocess at a temp folder. */
export function projectPaths(flags: Pick<Flags, "fake">): Paths {
  return makePaths(process.env.TRADER_ROOT || PROJECT_ROOT, flags.fake);
}

export interface Runtime {
  paths: Paths;
  keys: Keys;
  broker: Broker;
  brain: Brain;
  notifier: Notifier;
  log: Logger;
  store: Store;
}

/** TRADER_STORE=firestore keeps baton, history and lock in Firestore (the cloud setup); local files otherwise. */
export function buildStore(paths: Paths, keys: Keys, fake: boolean): Store {
  if (fake || process.env.TRADER_STORE !== "firestore") return new FileStore(paths);
  if (!keys.FIREBASE_SERVICE_ACCOUNT) throw new Error("TRADER_STORE=firestore ma FIREBASE_SERVICE_ACCOUNT è vuoto.");
  return new FirestoreStore(new FirestoreRest(parseServiceAccount(keys.FIREBASE_SERVICE_ACCOUNT)));
}

export async function buildRuntime(flags: Flags, runId: string, now: () => Date): Promise<Runtime> {
  const paths = projectPaths(flags);
  const keys = await loadKeys(PROJECT_ROOT);
  const log = makeLogger({ dir: paths.logs, runId, secrets: secretValues(keys) });

  if (flags.fake) {
    // Test hooks, honoured only by the fake broker and brain.
    const crash = Number(process.env.FAKE_CRASH_AFTER_SUBMITS || 0);
    const delay = Number(process.env.FAKE_BRAIN_DELAY_MS || 0);
    const broker = new FakeBroker(paths.fakeBroker, now, crash ? { crashAfterSubmits: crash } : {});
    const brain = new FakeBrain(async () => {
      if (delay) await Bun.sleep(delay);
      return FAKE_DECISION;
    });
    return { paths, keys, broker, brain, notifier: new ConsoleNotifier(), log, store: buildStore(paths, keys, true) };
  }

  assertPaperOnly(keys);
  const broker = new AlpacaPaperBroker(keys.ALPACA_KEY_ID, keys.ALPACA_SECRET_KEY);
  const brain = new ClaudeBrain({ oauthToken: keys.CLAUDE_CODE_OAUTH_TOKEN || undefined, cwd: paths.state });
  let notifier: Notifier;
  if (keys.TELEGRAM_BOT_TOKEN && keys.TELEGRAM_CHAT_ID) {
    notifier = new TelegramNotifier(keys.TELEGRAM_BOT_TOKEN, keys.TELEGRAM_CHAT_ID, log);
  } else {
    log.line("telegram", "token o chat id mancanti in secrets.ts: le notifiche vanno solo in console");
    notifier = new ConsoleNotifier();
  }
  return { paths, keys, broker, brain, notifier, log, store: buildStore(paths, keys, false) };
}

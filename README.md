# ai-trader — unattended paper trader on Alpaca

Built from `claude-trader.pdf` (prompts P-01 "il contratto" and P-02 "rompilo"). It wakes up 4 times a day, reads the
Alpaca **paper** account, asks Claude Code (headless, your subscription) for a decision, passes it through a cage of
hard-coded rules, sends the allowed orders, leaves a note (the *baton*) for the next wakeup, and reports on Telegram.

The goal is not profit. The goal is that it **never does the same thing twice** and **always tells the truth** about
what it did and what broke. Paper money only: the program refuses to start with live keys or a live endpoint.

## Setup

1. **Alpaca paper account** → app.alpaca.markets, switch to *Paper Trading*, generate API keys (Key ID starts with `PK`).
2. **Telegram bot** → @BotFather `/newbot`, copy the token; message your bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id`.
3. **Claude Code** logged in (`claude` once). On a server: `claude setup-token` and put it in `secrets.ts`.
4. `cp secrets.example.ts secrets.ts` and fill it in. `secrets.ts` is git-ignored; env vars with the same names also work.

Requires [Bun](https://bun.sh) (≥ 1.1). Zero runtime dependencies.

## Commands

| Command | What it does |
|---|---|
| `bun test` | all tests, fake broker + fake brain, must be all green |
| `bun run once --fake --slot 1540` | one test wakeup, no network, no keys (state in `state/fake/`) |
| `bun run once --slot 1540` | one real wakeup: Alpaca paper, Claude, Telegram |
| `bun run once --slot 1540 --force` | redo a wakeup already done; deterministic order ids prevent duplicates |
| `bun run schedule` | stays on, checks every 30 s, runs the due wakeup as a fresh process; status page on http://localhost:8787 |
| `bun run page` | only the status page on http://localhost:8787, reading the cloud trader's Firestore; never runs a wakeup |
| `bun run status` | lock, last baton, next wakeup, account |
| `bun run reconcile` | by hand: what did the interrupted run actually send |
| `bun src/cli/due.ts` | prints the wakeup due now, if any (used by the workflow) |
| `bun run once --due` | runs the due wakeup, or exits quietly (for any external cron) |

Add `--fake` to any command to use the fake broker and brain.

## Running in the cloud (GitHub Actions + Firestore, Mac off)

`.github/workflows/trader.yml` runs on GitHub's machines every 15 minutes around the four wakeups; `src/cli/due.ts`
decides whether one is due (extra ticks do nothing). Baton, history and lock live in Firestore
(`TRADER_STORE=firestore`); the lock becomes a 15-minute lease, since there is no local process to check. Logs of each
wakeup are kept 30 days as a workflow artifact. The model itself always runs on Anthropic's servers: the job only installs
the `claude` client and calls it with your subscription token.

One-time setup:

1. **Firebase project** (free Spark plan) → *Firestore Database* → create (production mode).
2. **Rules**: paste `firestore.rules` into *Firestore → Rules*, replacing the email with your Google account, and publish.
   The browser can only read, and only as you; the trader writes with a service account, which bypasses the rules.
3. **Service account**: *Project settings → Service accounts → Generate new private key*. The JSON file goes into the
   `FIREBASE_SERVICE_ACCOUNT` secret, then delete the downloaded file.
4. **Claude token**: `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` secret. When it expires, wakeups report
   "Cervello non disponibile" and only the stop loss runs until you replace it.
5. **GitHub secrets** (*Settings → Secrets and variables → Actions*): `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`,
   `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CLAUDE_CODE_OAUTH_TOKEN`, `FIREBASE_SERVICE_ACCOUNT`.
6. **Dashboard** (`web/`): *Authentication → Sign-in method → Google* on; add a *Web app* and copy its config into
   `web/config.js` (public values); add the dashboard's domain under *Authentication → Settings → Authorized domains*.
   `.github/workflows/pages.yml` publishes `web/` to GitHub Pages on every change.
7. Stop `bun run schedule` on the Mac (two schedulers would share nothing and both trade), then trigger the *trader*
   workflow by hand once (*Actions → trader → Run workflow*, slot `0900`) to check the whole chain.
8. **External trigger** (the real clock; GitHub's own cron is only a backup, see caveats). Create a fine-grained token
   (*GitHub → Settings → Developer settings → Fine-grained tokens*): owner `niccolovianello`, only this repository,
   permission *Actions: Read and write*. Then on [cron-job.org](https://cron-job.org) create one job:
   - URL `https://api.github.com/repos/niccolovianello/ai-trader/actions/workflows/trader.yml/dispatches`, method `POST`
   - headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - body `{"ref":"main"}` (no slot: `due.ts` decides, so extra ticks are no-ops)
   - time zone `Europe/Rome`, custom schedule `0,15,30,40,45,55 9,15,18,21 * * *` (each wakeup plus a few retries)

   When the token expires the job fails (cron-job.org emails you) and only GitHub's cron is left.

The dashboard shows the account as of the last wakeup: Alpaca keys never reach the browser.

Caveats: GitHub cron is best effort: often 5–30 minutes late, and on a new or quiet repo it can skip almost every tick
(on the first day it ran once in 21 hours), hence the external trigger. A wakeup more than 60 minutes late is reported
as missed. On a public repo GitHub disables scheduled workflows after 60 days without commits (it emails first;
re-enable with a click). GitHub Pages needs a public repo on the free plan.

## Wakeups (Rome time, US market 15:30–22:00)

| Time | Name | Does |
|---|---|---|
| 09:00 | briefing | reads the account, sets the plan. **No orders.** Also runs on weekends. |
| 15:40 | apertura | enters or adjusts |
| 18:30 | metà seduta | checks, stop loss |
| 21:40 | chiusura | closes the day |

A wakeup more than 60 minutes late is not run: the next one reports it as missed. Missed wakeups are never recovered.

## The cage (`src/config.ts`, `src/cage.ts`) — the model never sees it

- fixed universe: SPY QQQ IWM AAPL MSFT NVDA GLD TLT
- max 5 positions, max 20% of equity per symbol (counting shares already held)
- stop loss at −3% from entry: sells **even if the model says hold**, and even if the brain is down
- no shorts, no leverage (buys limited to cash), whole positive shares only
- no orders in the briefing or with the market closed (re-checked right before every order)

## How it stays safe when nobody is watching

| Mechanism | File |
|---|---|
| **Paper-only guard**: endpoint hard-coded; live `AK…` keys or a non-paper `ALPACA_BASE_URL` → refuses to start | `src/config.ts`, `src/keys.ts` |
| **Lock** `state/run.lock` (a lease in Firestore), created atomically; a dead run's lock is taken over by exactly one process, which reconciles with Alpaca and alerts | `src/lock.ts`, `src/reconcile.ts` |
| **Baton** `state/baton.json` (or Firestore `trader/baton`), written atomically with a copy in the history; corrupted = absent | `src/baton.ts`, `src/store/` |
| **Deterministic order ids** `YYYY-MM-DD-HHMM-SYMBOL-side`: checked before sending, and Alpaca rejects duplicates itself | `src/wakeup.ts` |
| **Lost responses**: after a network error the order is looked up by id → sent / not sent / *unknown outcome* + ⚠ | `src/wakeup.ts` |
| **Brain failures** (timeout, truncated JSON, missing field): no new orders, stop loss still runs, ⚠ message | `src/llm.ts` |
| **Logs** one file per wakeup in `logs/<runId>.log`, secrets replaced by `***` | `src/log.ts` |

Where to change things safely: schedule and limits in `src/config.ts`, cage logic in `src/cage.ts`, the brain and its
prompt in `src/llm.ts`, the notification channel in `src/notify.ts`. Run `bun test` after any change. **Do not change
`ALPACA_PAPER_URL`.**

## Known limits

- **Not yet run against the real Alpaca paper API or a real Telegram bot** — those need your keys. The Alpaca client is
  only tested with mocked HTTP. The real Claude brain was called once by hand and returned a valid decision (~15 s).
- Market orders, `time_in_force=day`. Day P&L uses Alpaca's `last_equity`.
- The scheduler uses weekdays for its slots; US market holidays are handled by Alpaca's clock (no orders), not skipped.
- If the market is closed when a stop is triggered, the stop is reported and executed at the next open wakeup.
- Prices for the cage come from the IEX feed (free paper data), which can differ slightly from the consolidated price.
- The status page binds to `127.0.0.1` only and has no auth. Docker setup and the `demo:*` scripts from the guide are not
  included.
- The tests were written by the same model that wrote the code. They include real `SIGKILL` crash tests and were
  mutation-checked (loosening the stop to −30% turns 5 tests red), but they are not proof.

Not financial advice. Paper account only.

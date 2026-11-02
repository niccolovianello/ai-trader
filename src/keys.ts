import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ALPACA_PAPER_URL } from "./config.ts";

export interface Keys {
  ALPACA_KEY_ID: string;
  ALPACA_SECRET_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  FIREBASE_SERVICE_ACCOUNT: string; // service-account JSON, only for the cloud store
}

const NAMES: (keyof Keys)[] = [
  "ALPACA_KEY_ID",
  "ALPACA_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "FIREBASE_SERVICE_ACCOUNT",
];

/** secrets.ts first, environment variables with the same names as fallback. */
export async function loadKeys(root: string): Promise<Keys> {
  let file: Partial<Keys> = {};
  const path = resolve(root, "secrets.ts");
  if (existsSync(path)) file = (await import(path)).secrets ?? {};
  const keys = {} as Keys;
  for (const n of NAMES) keys[n] = (file[n] || process.env[n] || "").trim();
  return keys;
}

export class PaperOnlyError extends Error {}

/**
 * Refuse to start against anything but the paper endpoint. Alpaca live keys start with "AK",
 * paper keys with "PK"; an explicit base URL override that is not paper is also refused.
 */
export function assertPaperOnly(keys: Keys, env: Record<string, string | undefined> = process.env) {
  for (const v of ["ALPACA_BASE_URL", "APCA_API_BASE_URL"]) {
    const url = env[v];
    if (url && url.replace(/\/+$/, "") !== ALPACA_PAPER_URL) {
      throw new PaperOnlyError(`${v} punta a ${url}: questo programma parla solo con ${ALPACA_PAPER_URL}. Mi rifiuto di partire.`);
    }
  }
  if (keys.ALPACA_KEY_ID.startsWith("AK")) {
    throw new PaperOnlyError("La Key ID di Alpaca sembra di un conto vero (inizia con AK). Usa le chiavi Paper (PK…). Mi rifiuto di partire.");
  }
}

export function secretValues(keys: Keys): string[] {
  const out = Object.values(keys).filter((v) => v.length >= 6);
  try {
    // The private key is printed escaped or unescaped depending on who logs it: mask both forms.
    const pk: string = JSON.parse(keys.FIREBASE_SERVICE_ACCOUNT).private_key ?? "";
    if (pk) out.push(pk, JSON.stringify(pk).slice(1, -1));
  } catch {}
  return out;
}

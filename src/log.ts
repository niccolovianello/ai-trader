import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Logger {
  line(tag: string, msg: string): void;
  readonly file: string | null;
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out;
}

/** One file per run in logs/<runId>.log, secrets replaced by ***. */
export function makeLogger(opts: { dir: string; runId: string; secrets: string[]; quiet?: boolean }): Logger {
  mkdirSync(opts.dir, { recursive: true });
  const file = join(opts.dir, `${opts.runId}.log`);
  return {
    file,
    line(tag, msg) {
      const text = redact(`[${tag.padEnd(9)}] ${msg}`, opts.secrets);
      if (!opts.quiet) console.log(text);
      try {
        appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
      } catch {
        // a log write failure must not stop the run
      }
    },
  };
}

export const nullLogger: Logger = { file: null, line() {} };

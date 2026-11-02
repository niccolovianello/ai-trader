import type { Logger } from "./log.ts";

export interface Notifier {
  send(text: string): Promise<void>;
}

/** Never throws: if Telegram is down the run goes on and the failure goes in the log. */
export class TelegramNotifier implements Notifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly log: Logger,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(text: string) {
    try {
      const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) this.log.line("telegram", `non consegnato: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      this.log.line("telegram", `non raggiungibile: ${(e as Error).message}`);
    }
  }
}

export class ConsoleNotifier implements Notifier {
  readonly sent: string[] = [];
  constructor(private readonly quiet = false) {}
  async send(text: string) {
    this.sent.push(text);
    if (!this.quiet) console.log(`\n──── notifica ────\n${text}\n──────────────────\n`);
  }
}

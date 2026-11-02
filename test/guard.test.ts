import { describe, expect, test } from "bun:test";
import { AlpacaPaperBroker } from "../src/broker/alpaca.ts";
import { BrokerUnreachableError, DuplicateOrderError } from "../src/broker/types.ts";
import { ALPACA_PAPER_URL } from "../src/config.ts";
import { assertPaperOnly, type Keys, PaperOnlyError } from "../src/keys.ts";
import { parseDecision, BrainError } from "../src/llm.ts";
import { nullLogger, redact } from "../src/log.ts";
import { TelegramNotifier } from "../src/notify.ts";

const keys = (id: string): Keys => ({ ALPACA_KEY_ID: id, ALPACA_SECRET_KEY: "s".repeat(40), TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", CLAUDE_CODE_OAUTH_TOKEN: "", FIREBASE_SERVICE_ACCOUNT: "" });

describe("solo paper trading", () => {
  test("rifiuta un endpoint diverso da quello paper", () => {
    expect(() => assertPaperOnly(keys("PK123"), { ALPACA_BASE_URL: "https://api.alpaca.markets" })).toThrow(PaperOnlyError);
    expect(() => assertPaperOnly(keys("PK123"), { APCA_API_BASE_URL: "https://api.alpaca.markets" })).toThrow(PaperOnlyError);
  });

  test("rifiuta chiavi di un conto vero", () => {
    expect(() => assertPaperOnly(keys("AKLIVE123"), {})).toThrow(PaperOnlyError);
  });

  test("accetta chiavi paper e l'endpoint paper", () => {
    expect(() => assertPaperOnly(keys("PK123"), { ALPACA_BASE_URL: ALPACA_PAPER_URL + "/" })).not.toThrow();
  });

  test("il client parla solo con l'indirizzo paper", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ equity: "1", last_equity: "1", cash: "1", is_open: true }));
    }) as unknown as typeof fetch;
    const b = new AlpacaPaperBroker("PK1", "secret", fake, 0);
    await b.getAccount();
    await b.getClock();
    expect(urls.every((u) => u.startsWith(ALPACA_PAPER_URL + "/"))).toBe(true);
  });
});

describe("client Alpaca", () => {
  test("422 su client_order_id → doppione", async () => {
    const fake = (async () => new Response('{"message":"client_order_id must be unique"}', { status: 422 })) as unknown as typeof fetch;
    const b = new AlpacaPaperBroker("PK1", "secret", fake, 0);
    await expect(b.submitOrder({ symbol: "SPY", side: "buy", qty: 1, clientOrderId: "x" })).rejects.toBeInstanceOf(DuplicateOrderError);
  });

  test("le letture riprovano tre volte, poi errore pulito", async () => {
    let calls = 0;
    const fake = (async () => { calls++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const b = new AlpacaPaperBroker("PK1", "secret", fake, 0);
    await expect(b.getAccount()).rejects.toBeInstanceOf(BrokerUnreachableError);
    expect(calls).toBe(3);
  });

  test("l'invio di un ordine non viene mai ripetuto alla cieca", async () => {
    let calls = 0;
    const fake = (async () => { calls++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const b = new AlpacaPaperBroker("PK1", "secret", fake, 0);
    await expect(b.submitOrder({ symbol: "SPY", side: "buy", qty: 1, clientOrderId: "x" })).rejects.toBeInstanceOf(BrokerUnreachableError);
    expect(calls).toBe(1);
  });

  test("404 sulla ricerca per id → nessun ordine", async () => {
    const fake = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await new AlpacaPaperBroker("PK1", "secret", fake, 0).getOrderByClientId("x")).toBeNull();
  });
});

describe("chiavi e canale", () => {
  test("le chiavi nei log diventano ***", () => {
    expect(redact("token 123456:ABCDEF in url", ["123456:ABCDEF"])).toBe("token *** in url");
  });

  test("se Telegram non risponde la sveglia non si ferma", async () => {
    const lines: string[] = [];
    const fake = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const n = new TelegramNotifier("tok", "1", { file: null, line: (_t, m) => lines.push(m) }, fake);
    await expect(n.send("ciao")).resolves.toBeUndefined();
    expect(lines[0]).toContain("non raggiungibile");
  });

  test("risposta di Telegram non ok → nel log", async () => {
    const fake = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    await expect(new TelegramNotifier("tok", "1", nullLogger, fake).send("x")).resolves.toBeUndefined();
  });
});

describe("risposta del cervello", () => {
  test("accetta JSON in un blocco di codice", () => {
    expect(parseDecision('```json\n{"orders":[],"reasoning":"r","planNext":"p"}\n```').orders).toEqual([]);
  });
  test("lato sconosciuto → errore", () => {
    expect(() => parseDecision({ orders: [{ symbol: "SPY", side: "short", qty: 1 }], reasoning: "r", planNext: "p" })).toThrow(BrainError);
  });
});

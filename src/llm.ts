import { BRAIN, CAGE } from "./config.ts";
import type { Account, Baton, BrokerOrder, Decision, Position, ProposedOrder } from "./types.ts";

export interface BrainInput {
  runId: string;
  slotName: string;
  ordersAllowed: boolean;
  marketOpen: boolean;
  baton: Baton | null;
  account: Account;
  positions: Position[];
  recentOrders: BrokerOrder[];
  prices: Record<string, number>; // latest trade, whole universe
}

export interface Brain {
  readonly kind: "claude" | "finto";
  decide(input: BrainInput): Promise<Decision>;
}

export class BrainError extends Error {}

const DECISION_SCHEMA = {
  type: "object",
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          qty: { type: "integer" },
          why: { type: "string" },
        },
        required: ["symbol", "side", "qty", "why"],
      },
    },
    reasoning: { type: "string" },
    planNext: { type: "string" },
  },
  required: ["orders", "reasoning", "planNext"],
};

/** Strict validation of whatever came back. Anything malformed means "brain unavailable". */
export function parseDecision(raw: unknown): Decision {
  let v = raw;
  if (typeof v === "string") {
    const text = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
    try {
      v = JSON.parse(text);
    } catch {
      throw new BrainError("risposta del cervello non è JSON valido (troncata?)");
    }
  }
  if (!v || typeof v !== "object") throw new BrainError("risposta del cervello vuota");
  const d = v as Record<string, unknown>;
  if (!Array.isArray(d.orders)) throw new BrainError("campo 'orders' mancante");
  if (typeof d.reasoning !== "string" || !d.reasoning.trim()) throw new BrainError("campo 'reasoning' mancante");
  if (typeof d.planNext !== "string") throw new BrainError("campo 'planNext' mancante");
  const orders: ProposedOrder[] = d.orders.map((o: any, i: number) => {
    if (!o || typeof o.symbol !== "string" || (o.side !== "buy" && o.side !== "sell") || typeof o.qty !== "number") {
      throw new BrainError(`ordine ${i + 1} malformato`);
    }
    // qty sign and integrality are the cage's job: it rejects the single order, not the whole decision.
    return { symbol: o.symbol.trim().toUpperCase(), side: o.side, qty: o.qty, why: String(o.why ?? "") };
  });
  return { orders, reasoning: d.reasoning.trim(), planNext: d.planNext.trim() };
}

export function buildPrompt(input: BrainInput): string {
  const usd = (n: number) => n.toFixed(2);
  const positions = input.positions.length
    ? input.positions
        .map((p) => `- ${p.symbol}: ${p.qty} az., carico ${usd(p.avgEntryPrice)}, ora ${usd(p.currentPrice)}, valore ${usd(p.marketValue)}, ${(p.unrealizedPlPct * 100).toFixed(2)}%`)
        .join("\n")
    : "- nessuna";
  const orders = input.recentOrders.length
    ? input.recentOrders.map((o) => `- ${o.submittedAt} ${o.side} ${o.qty} ${o.symbol} · ${o.status}`).join("\n")
    : "- nessuno";
  const baton = input.baton
    ? `Sveglia ${input.baton.runId} (${input.baton.slotName}).\nPerché: ${input.baton.reasoning}\nProssima mossa: ${input.baton.planNext}`
    : "Nessun testimone: è la prima sveglia, o il testimone era illeggibile. Riparti dai dati del broker.";

  return `Sei un trader che lavora su un conto DEMO (paper trading Alpaca, soldi finti, prezzi veri).
Ogni sveglia parte senza memoria: il "testimone" qui sotto è l'unico appunto lasciato dalla sveglia precedente.

Sveglia: ${input.runId} · ${input.slotName}
Mercato USA: ${input.marketOpen ? "aperto" : "chiuso"}
${input.ordersAllowed && input.marketOpen ? "Puoi proporre ordini." : "In questa sveglia NON si mandano ordini: proponi una lista 'orders' vuota e fissa il piano."}
Titoli trattabili: ${CAGE.universe.join(" ")}. Solo azioni intere, niente short, niente leva.

## Testimone della sveglia precedente
${baton}

## Conto
Equity ${usd(input.account.equity)} $ · liquidità ${usd(input.account.cash)} $ · equity alla chiusura precedente ${usd(input.account.lastEquity)} $

## Prezzi (ultimo scambio)
${CAGE.universe.map((s) => `${s} ${input.prices[s] ? usd(input.prices[s]) : "n.d."}`).join(" · ")}

## Posizioni
${positions}

## Ordini delle ultime 48 ore
${orders}

Rispondi SOLO con un oggetto JSON, in italiano:
- "orders": array di { "symbol", "side" ("buy"|"sell"), "qty" (intero positivo), "why" (una frase) }
- "reasoning": 3–5 frasi sul perché
- "planNext": cosa controllare alla prossima sveglia`;
}

export class ClaudeBrain implements Brain {
  readonly kind = "claude" as const;
  constructor(private readonly opts: { oauthToken?: string; cwd: string; timeoutMs?: number; model?: string }) {}

  async decide(input: BrainInput): Promise<Decision> {
    const args = [
      "claude", "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(DECISION_SCHEMA),
      "--tools", "",
      "--no-session-persistence",
      "--strict-mcp-config",
    ];
    const model = this.opts.model ?? BRAIN.model;
    if (model) args.push("--model", model);
    const env: Record<string, string | undefined> = { ...process.env };
    if (this.opts.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.opts.oauthToken;

    let proc;
    try {
      proc = Bun.spawn(args, { cwd: this.opts.cwd, env, stdin: new Blob([buildPrompt(input)]), stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new BrainError(`impossibile avviare claude: ${(e as Error).message}`);
    }
    const timeout = setTimeout(() => proc.kill("SIGKILL"), this.opts.timeoutMs ?? BRAIN.timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timeout);
    if (proc.signalCode === "SIGKILL") throw new BrainError("il cervello è andato in timeout");
    if (code !== 0) throw new BrainError(`claude è uscito con codice ${code}: ${(err || out).slice(0, 300)}`);

    let envelope: any;
    try {
      envelope = JSON.parse(out);
    } catch {
      throw new BrainError("uscita di claude non è JSON");
    }
    if (envelope.is_error) throw new BrainError(`claude ha risposto con un errore: ${String(envelope.result).slice(0, 300)}`);
    return parseDecision(envelope.structured_output ?? envelope.result);
  }
}

export const FAKE_DECISION: Decision = {
  orders: [
    { symbol: "SPY", side: "buy", qty: 20, why: "indice largo, base del portafoglio" },
    { symbol: "QQQ", side: "buy", qty: 10, why: "tecnologia" },
    { symbol: "GLD", side: "buy", qty: 25, why: "oro, copertura" },
  ],
  reasoning: "Prova con broker e cervello finti: eseguo il piano fisso. Circa un terzo del conto su tre pilastri, il resto in liquidità.",
  planNext: "Alla prossima sveglia controllare che nessuna posizione sia vicina allo stop.",
};

/** Always answers the same thing (or whatever a test hands it). */
export class FakeBrain implements Brain {
  readonly kind = "finto" as const;
  constructor(private readonly answer: (input: BrainInput) => unknown | Promise<unknown> = () => FAKE_DECISION) {}
  async decide(input: BrainInput): Promise<Decision> {
    return parseDecision(await this.answer(input));
  }
}

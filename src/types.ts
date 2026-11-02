export type Side = "buy" | "sell";

export interface Account {
  equity: number;
  lastEquity: number; // equity at previous close, for day P&L
  cash: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPlPct: number; // -0.04 = -4%
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  status: string;
  filledQty: number;
  filledAvgPrice: number | null;
  submittedAt: string;
}

export interface MarketClock {
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  clientOrderId: string;
}

export interface ProposedOrder {
  symbol: string;
  side: Side;
  qty: number;
  why: string;
}

export interface Decision {
  orders: ProposedOrder[];
  reasoning: string;
  planNext: string;
}

export interface CagedOrder extends ProposedOrder {
  forced?: boolean; // stop loss, not proposed by the model
}

export interface RejectedOrder {
  order: ProposedOrder;
  reason: string;
}

export type SubmitOutcome = "inviato" | "già presente" | "non partito" | "esito sconosciuto" | "mercato chiuso";

export interface SubmittedOrder {
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  forced: boolean;
  outcome: SubmitOutcome;
  status?: string;
  error?: string;
}

export interface Baton {
  version: 1;
  runId: string;
  slot: string;
  slotName: string;
  runAt: string; // ISO
  status: "ok" | "error";
  brain: "ok" | "non disponibile" | "finto";
  orders: SubmittedOrder[];
  rejected: { symbol: string; side: Side; qty: number; reason: string }[];
  reasoning: string;
  planNext: string;
  equity: number | null;
  dayPnl: number | null;
  positions: { symbol: string; qty: number; avgEntryPrice?: number; marketValue?: number; unrealizedPlPct: number }[];
  alerts: string[];
  nextRun: string | null;
}

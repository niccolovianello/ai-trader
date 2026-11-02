import type { Broker } from "./broker/types.ts";
import type { LockInfo } from "./lock.ts";
import type { BrokerOrder } from "./types.ts";

export interface Reconciliation {
  runId: string;
  orders: BrokerOrder[];
  summary: string;
}

/** What did the interrupted run actually get onto the broker? Its orders carry its run id as prefix. */
export async function reconcile(broker: Broker, stale: LockInfo, now: Date): Promise<Reconciliation> {
  const since = stale.startedAt ? new Date(new Date(stale.startedAt).getTime() - 60_000) : new Date(now.getTime() - 48 * 3600_000);
  const all = await broker.getOrdersSince(since);
  const orders = all.filter((o) => o.clientOrderId?.startsWith(`${stale.runId}-`));
  const summary = orders.length
    ? orders.map((o) => `${o.side === "buy" ? "comprato" : "venduto"} ${o.qty} ${o.symbol} (${o.status})`).join("; ")
    : "nessun ordine arrivato al broker";
  return { runId: stale.runId, orders, summary };
}

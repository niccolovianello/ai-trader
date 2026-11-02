import type { Account, BrokerOrder, MarketClock, OrderRequest, Position } from "../types.ts";

export interface Broker {
  readonly kind: "alpaca-paper" | "finto";
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getOrdersSince(since: Date): Promise<BrokerOrder[]>;
  getClock(): Promise<MarketClock>;
  /** null when the broker has no order with this client id. */
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
  getLatestPrices(symbols: string[]): Promise<Record<string, number>>;
  /** Not retried: a lost response is resolved by looking the order up by its client id. */
  submitOrder(req: OrderRequest): Promise<BrokerOrder>;
}

/** The broker already has an order with this client id. */
export class DuplicateOrderError extends Error {}

/** Network-level failure: the request may or may not have reached the broker. */
export class BrokerUnreachableError extends Error {}

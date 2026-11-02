import type { Doc, DocClient, Fields } from "../src/store/firestore.ts";

/** In-memory stand-in for Firestore with the same atomicity rules: create fails if present, updates check updateTime. */
export class MemoryDocs implements DocClient {
  readonly docs = new Map<string, Doc>();
  private clock = 0;
  /** Simulate an outage. */
  down = false;
  /** Store the next create but report "already exists": what the REST client sees when it retries a create whose response was lost. */
  loseNextCreateResponse = false;

  private stamp() {
    return new Date(Date.UTC(2026, 0, 1) + ++this.clock).toISOString();
  }
  private check() {
    if (this.down) throw new Error("Firestore non risponde: rete giù");
  }

  async get(path: string) {
    this.check();
    const d = this.docs.get(path);
    return d ? { fields: { ...d.fields }, updateTime: d.updateTime } : null;
  }
  async create(path: string, fields: Fields) {
    this.check();
    if (this.docs.has(path)) return false;
    this.docs.set(path, { fields: { ...fields }, updateTime: this.stamp() });
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      return false;
    }
    return true;
  }
  async replace(path: string, fields: Fields, ifUpdateTime: string) {
    this.check();
    if (this.docs.get(path)?.updateTime !== ifUpdateTime) return false;
    this.docs.set(path, { fields: { ...fields }, updateTime: this.stamp() });
    return true;
  }
  async delete(path: string, ifUpdateTime: string) {
    this.check();
    if (this.docs.get(path)?.updateTime !== ifUpdateTime) return false;
    this.docs.delete(path);
    return true;
  }
  async commit(writes: { path: string; fields: Fields }[]) {
    this.check();
    for (const w of writes) this.docs.set(w.path, { fields: { ...w.fields }, updateTime: this.stamp() });
  }
  async listDesc(collection: string, limit: number) {
    this.check();
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(`${collection}/`) && !p.slice(collection.length + 1).includes("/"))
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, limit)
      .map(([, d]) => d);
  }
}

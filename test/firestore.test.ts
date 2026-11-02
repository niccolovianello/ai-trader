import { describe, expect, test } from "bun:test";
import { CLOUD } from "../src/config.ts";
import { FAKE_DECISION } from "../src/llm.ts";
import { FirestoreStore } from "../src/store/firestore.ts";
import { FirestoreRest, signJwt, type ServiceAccount } from "../src/store/firestoreRest.ts";
import { DAY, harness } from "./helpers.ts";
import { MemoryDocs } from "./memoryDocs.ts";

const info = (runId: string, holder: string, now = new Date()) => ({ runId, pid: 0, startedAt: now.toISOString(), holder });

describe("sveglia con stato su Firestore", () => {
  test("stessa sveglia due volte → un solo ordine per titolo", async () => {
    const h = harness({ store: "firestore" });
    expect((await h.run("1540")).status).toBe("done");
    expect((await h.run("1540")).status).toBe("already-done");
    expect(h.broker.read().orders).toHaveLength(3);
    expect(h.docs!.docs.has("trader/lock")).toBe(false);
  });

  test("testimone e storico scritti insieme; storico in ordine", async () => {
    const h = harness({ store: "firestore" });
    await h.run("0900");
    await h.run("1540");
    expect(JSON.parse(h.docs!.docs.get("trader/baton")!.fields.json!).runId).toBe(`${DAY}-1540`);
    expect((await h.store.history(10)).map((b) => b.runId)).toEqual([`${DAY}-0900`, `${DAY}-1540`]);
  });

  test("sveglie saltate segnalate anche dal cloud", async () => {
    const h = harness({ store: "firestore" });
    await h.run("0900");
    await h.run("2140");
    expect(h.notifier.sent.join("\n")).toContain(`Sveglie saltate (macchina spenta o offline): ${DAY} 15:40, ${DAY} 18:30`);
  });

  test("testimone corrotto → vale come nessuno", async () => {
    const h = harness({ store: "firestore" });
    h.docs!.docs.set("trader/baton", { fields: { json: '{"version":1,"runId":"20' }, updateTime: "t" });
    expect((await h.run("1540")).status).toBe("done");
    expect(h.broker.read().orders).toHaveLength(3);
  });

  test("lease di una sveglia morta (scaduto) → riconcilia, avvisa, lavora", async () => {
    const h = harness({ store: "firestore" });
    const old = new Date(h.clock.now.getTime() - CLOUD.leaseMs - 60_000);
    await new FirestoreStore(h.docs!).acquireLock(info(`${DAY}-0900`, "morta", old), old);
    const r = await h.run("1540");
    expect(r.status).toBe("done");
    expect(h.notifier.sent.join("\n")).toContain(`Sveglia precedente interrotta (run ${DAY}-0900)`);
  });

  test("lease vivo → la sveglia esce senza fare niente", async () => {
    const h = harness({ store: "firestore" });
    await new FirestoreStore(h.docs!).acquireLock(info(`${DAY}-1540`, "viva", h.clock.now), h.clock.now);
    expect((await h.run("1540")).status).toBe("busy");
    expect(h.broker.read().orders).toHaveLength(0);
    expect(h.docs!.docs.get("trader/lock")!.fields.holder).toBe("viva");
  });

  test("Firestore giù → sveglia non parte, ❌ su Telegram, nessun ordine", async () => {
    const h = harness({ store: "firestore" });
    h.docs!.down = true;
    const r = await h.run("1540");
    expect(r.status).toBe("error");
    expect(h.notifier.sent.at(-1)).toContain("❌ Sveglia non partita");
    expect(h.broker.read().orders).toHaveLength(0);
  });

  test("Firestore cade a metà sveglia → ordini già inviati restano, lock scade da solo", async () => {
    const h = harness({ store: "firestore" });
    const r = await h.run("1540", { brain: () => FAKE_DECISION });
    expect(r.status).toBe("done");
    const h2 = harness({ store: "firestore" });
    const r2 = await h2.run("1540", { brain: () => { h2.docs!.down = true; return FAKE_DECISION; } });
    expect(r2.status).toBe("error"); // baton write failed
    expect(h2.broker.read().orders).toHaveLength(3); // orders went out; the next run reconciles by id
  });
});

describe("lease su Firestore", () => {
  test("due sveglie trovano insieme un lease scaduto → ne passa una sola", async () => {
    const docs = new MemoryDocs();
    const store = new FirestoreStore(docs);
    const now = new Date();
    const old = new Date(now.getTime() - CLOUD.leaseMs - 1);
    await store.acquireLock(info("morta", "x", old), old);
    const [a, b] = await Promise.all([store.acquireLock(info("a", "A", now), now), store.acquireLock(info("b", "B", now), now)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  test("risposta persa sulla creazione del lock → riconosce il proprio lock", async () => {
    const docs = new MemoryDocs();
    docs.loseNextCreateResponse = true;
    const r = await new FirestoreStore(docs).acquireLock(info("a", "A"), new Date());
    expect(r).toEqual({ ok: true, stale: null });
  });

  test("si rilascia solo il proprio lock", async () => {
    const docs = new MemoryDocs();
    const store = new FirestoreStore(docs);
    await store.acquireLock(info("a", "A"), new Date());
    await store.releaseLock(info("b", "B"));
    expect(docs.docs.has("trader/lock")).toBe(true);
    await store.releaseLock(info("a", "A"));
    expect(docs.docs.has("trader/lock")).toBe(false);
  });
});

describe("client REST Firestore", () => {
  async function serviceAccount(): Promise<{ sa: ServiceAccount; publicKey: CryptoKey }> {
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    return { sa: { project_id: "p1", client_email: "t@p1.iam.gserviceaccount.com", private_key: pem }, publicKey: kp.publicKey };
  }

  test("il JWT del service account è firmato correttamente", async () => {
    const { sa, publicKey } = await serviceAccount();
    const jwt = await signJwt(sa, "scope-x", 1_700_000_000_000);
    const [h, c, s] = jwt.split(".");
    const fromB64 = (x: string) => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    expect(JSON.parse(fromB64(c!).toString())).toMatchObject({ iss: sa.client_email, scope: "scope-x", iat: 1_700_000_000, exp: 1_700_003_600 });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, fromB64(s!), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
  });

  test("create/replace/get/runQuery parlano l'API giusta e capiscono i conflitti", async () => {
    const { sa } = await serviceAccount();
    const calls: { method: string; url: string; body?: any }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: String(init.method), url, body });
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
      if (init.method === "POST" && url.includes("documentId=lock")) return new Response('{"error":{"status":"ALREADY_EXISTS"}}', { status: 409 });
      if (init.method === "PATCH") return new Response('{"error":{"status":"FAILED_PRECONDITION"}}', { status: 400 });
      if (init.method === "GET" && url.endsWith("/missing")) return new Response("{}", { status: 404 });
      if (init.method === "GET") return Response.json({ fields: { runId: { stringValue: "r1" } }, updateTime: "u1" });
      if (url.endsWith(":runQuery")) return Response.json([{ document: { fields: { json: { stringValue: "{}" } }, updateTime: "u" } }, { readTime: "x" }]);
      return Response.json({});
    }) as unknown as typeof fetch;
    const db = new FirestoreRest(sa, fake, 0);
    const base = "https://firestore.googleapis.com/v1/projects/p1/databases/(default)/documents";

    expect(await db.create("trader/lock", { a: "1" })).toBe(false);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${base}/trader?documentId=lock`, body: { fields: { a: { stringValue: "1" } } } });
    expect(await db.replace("trader/lock", { a: "2" }, "2026-01-01T00:00:00Z")).toBe(false);
    expect(calls[1]!.url).toBe(`${base}/trader/lock?currentDocument.updateTime=2026-01-01T00%3A00%3A00Z`);
    expect(await db.get("trader/missing")).toBeNull();
    expect(await db.get("trader/baton")).toEqual({ fields: { runId: "r1" }, updateTime: "u1" });
    expect(await db.listDesc("history", 5)).toHaveLength(1);
    await db.commit([{ path: "history/r1", fields: { json: "{}" } }]);
    expect(calls.at(-1)!.body.writes[0].update.name).toBe("projects/p1/databases/(default)/documents/history/r1");
  });
});

import type { Doc, DocClient, Fields } from "./firestore.ts";

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let sa: any;
  try {
    sa = JSON.parse(json);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT non è un JSON valido (incolla il file della chiave così com'è)");
  }
  if (!sa?.project_id || !sa?.client_email || !sa?.private_key) throw new Error("FIREBASE_SERVICE_ACCOUNT incompleto: servono project_id, client_email, private_key");
  return sa;
}

const b64url = (data: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof data === "string" ? data : new Uint8Array(data)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Service-account JWT signed with WebCrypto, so no Google SDK is needed. */
export async function signJwt(sa: ServiceAccount, scope: string, now = Date.now()): Promise<string> {
  const der = Buffer.from(sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Firestore HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

const encode = (f: Fields) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { stringValue: v }]));
const decode = (raw: any): Doc => ({
  fields: Object.fromEntries(Object.entries<any>(raw.fields ?? {}).map(([k, v]) => [k, String(v.stringValue ?? v.integerValue ?? v.timestampValue ?? "")])),
  updateTime: raw.updateTime,
});

/** Firestore REST v1 with a service account. Service-account calls bypass security rules; the browser does not. */
export class FirestoreRest implements DocClient {
  private token: { value: string; exp: number } | null = null;
  private readonly root: string;
  private readonly base: string;

  constructor(private readonly sa: ServiceAccount, private readonly fetchFn: typeof fetch = fetch, private readonly retryDelayMs = 1000) {
    this.root = `projects/${sa.project_id}/databases/(default)/documents`;
    this.base = `https://firestore.googleapis.com/v1/${this.root}`;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const assertion = await signJwt(this.sa, "https://www.googleapis.com/auth/datastore");
    const res = await this.fetchFn(this.sa.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw new Error(`login Firebase fallito: HTTP ${res.status} ${body.error_description ?? body.error ?? ""}`);
    this.token = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Every operation here is safe to repeat, so network errors and 5xx get three tries. */
  private async call(method: string, url: string, body?: unknown): Promise<any> {
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const res = await this.fetchFn(url, {
          method,
          headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        if (res.ok) return text ? JSON.parse(text) : null;
        const err = new HttpError(res.status, text);
        if (res.status < 500 && res.status !== 429) throw err;
        last = err;
      } catch (e) {
        if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
        last = e;
      }
      if (i < 2) await Bun.sleep(this.retryDelayMs * (i + 1));
    }
    throw new Error(`Firestore non risponde: ${(last as Error).message}`);
  }

  private static preconditionFailed(e: unknown) {
    return e instanceof HttpError && (e.status === 409 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/.test(e.body));
  }

  async get(path: string) {
    try {
      return decode(await this.call("GET", `${this.base}/${path}`));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  async create(path: string, fields: Fields) {
    const i = path.lastIndexOf("/");
    try {
      await this.call("POST", `${this.base}/${path.slice(0, i)}?documentId=${encodeURIComponent(path.slice(i + 1))}`, { fields: encode(fields) });
      return true;
    } catch (e) {
      if (FirestoreRest.preconditionFailed(e)) return false;
      throw e;
    }
  }

  async replace(path: string, fields: Fields, ifUpdateTime: string) {
    try {
      await this.call("PATCH", `${this.base}/${path}?currentDocument.updateTime=${encodeURIComponent(ifUpdateTime)}`, { fields: encode(fields) });
      return true;
    } catch (e) {
      if (FirestoreRest.preconditionFailed(e)) return false;
      throw e;
    }
  }

  async delete(path: string, ifUpdateTime: string) {
    try {
      await this.call("DELETE", `${this.base}/${path}?currentDocument.updateTime=${encodeURIComponent(ifUpdateTime)}`);
      return true;
    } catch (e) {
      if (FirestoreRest.preconditionFailed(e) || (e instanceof HttpError && e.status === 404)) return false;
      throw e;
    }
  }

  async commit(writes: { path: string; fields: Fields }[]) {
    await this.call("POST", `${this.base}:commit`, {
      writes: writes.map((w) => ({ update: { name: `${this.root}/${w.path}`, fields: encode(w.fields) } })),
    });
  }

  async listDesc(collection: string, limit: number) {
    const rows: any[] = await this.call("POST", `${this.base}:runQuery`, {
      structuredQuery: {
        from: [{ collectionId: collection }],
        orderBy: [{ field: { fieldPath: "__name__" }, direction: "DESCENDING" }],
        limit,
      },
    });
    return (rows ?? []).filter((r) => r.document).map((r) => decode(r.document));
  }
}

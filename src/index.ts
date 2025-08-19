/**
 * Cloudflare AI Gateway /logs → GCS(JSONL) Writer
 * - Forward fetch: id > last_id
 * - Backfill: created_at >= now() - BACKFILL_MINUTES
 * - Upload each record as rows/dt=YYYY-MM-DD/hour=HH/<id>.jsonl with "create-only" mode
 * - Store last_id and lock in Durable Object
 */

export interface Env {
  // vars
  CF_API_BASE: string;
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  GCS_BUCKET: string;
  GCS_PREFIX: string;
  PER_PAGE: string;
  PARALLEL_UPLOAD: string;
  BACKFILL_MINUTES: string;
  MAX_WALL_MS: string;
  SAFETY_MS: string;
  MAX_PAGES_PER_RUN: string;
  GCP_OAUTH_AUD: string;
  GCP_OAUTH_SCOPE: string;

  // secrets
  CF_API_TOKEN: string;
  GCP_SA_EMAIL: string;
  GCP_SA_PRIVATE_KEY: string;

  // DO
  INGESTOR: DurableObjectNamespace;
}

type LogsListResponse = {
  success: boolean;
  result: any[];
  result_info?: { page?: number; per_page?: number; count?: number; total_count?: number };
  errors?: any[];
  messages?: any[];
};

type Checkpoint = {
  lastId: string;       // ULID
  updatedAt: string;    // ISO
};

const MIN_ULID = "00000000000000000000000000";

/** ===== Utility: limits / params ===== */
function getInt(envVal: string | undefined, def: number): number {
  if (!envVal) return def;
  const n = parseInt(envVal, 10);
  return Number.isFinite(n) ? n : def;
}

function nowIso() {
  return new Date().toISOString();
}

/** ===== OAuth (Google Service Account) ===== */
const enc = new TextEncoder();

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function importPKCS8(pem: string): Promise<CryptoKey> {
  const h = "-----BEGIN PRIVATE KEY-----";
  const f = "-----END PRIVATE KEY-----";
  const i = pem.indexOf(h), j = pem.indexOf(f);
  if (i === -1 || j === -1) throw new Error("Invalid GCP_SA_PRIVATE_KEY (PEM)");
  const b64 = pem.slice(i + h.length, j).replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function getGcsAccessToken(env: Env): Promise<{ token: string; exp: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64url(
    enc.encode(
      JSON.stringify({
        iss: env.GCP_SA_EMAIL,
        scope: env.GCP_OAUTH_SCOPE,
        aud: env.GCP_OAUTH_AUD,
        iat,
        exp,
      })
    )
  );
  const input = `${header}.${claims}`;
  const key = await importPKCS8(env.GCP_SA_PRIVATE_KEY);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input));
  const jwt = `${input}.${base64url(sig)}`;

  const res = await fetch(env.GCP_OAUTH_AUD, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCS token exchange failed: ${res.status} ${await res.text()}`);
  }
  const j = (await res.json()) as any;
  return { token: j.access_token as string, exp: iat + (j.expires_in ?? 3600) };
}

/** ===== GCS upload (create-only) ===== */
async function uploadJsonlCreateOnly(env: Env, gcsToken: string, objectName: string, jsonLine: string) {
  const url = new URL(
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(env.GCS_BUCKET)}/o`
  );
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", objectName);
  url.searchParams.set("ifGenerationMatch", "0"); // Create only if not exists

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gcsToken}`,
      "Content-Type": "application/x-ndjson",
    },
    body: jsonLine, // 1 record = 1 line
  });

  // If already exists (re-run/duplicate), it may return 409 or 412 → treat as success
  if (res.status === 409 || res.status === 412) return;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GCS upload failed: ${res.status} ${body}`);
  }
}

/** ===== Simple concurrency limiter ===== */
function pLimit(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        task().then(
          (v) => {
            next();
            resolve(v);
          },
          (e) => {
            next();
            reject(e);
          }
        );
      };
      if (active < n) run();
      else queue.push(run);
    });
}

/** ===== CF Logs API ===== */
async function fetchLogsPage(env: Env, opts: {
  filterKey: "id" | "created_at";
  operator: "gt" | "gte";
  value: string;          // ISO datetime or ULID
  page: number;
  perPage: number;
}): Promise<LogsListResponse> {
  const url = new URL(
    `${env.CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.CF_GATEWAY_ID}/logs`
  );
  url.searchParams.set("order_by", "created_at");
  url.searchParams.set("order_by_direction", "asc");
  url.searchParams.set("per_page", String(opts.perPage));
  url.searchParams.set("page", String(opts.page));

  url.searchParams.set("filters[0][key]", opts.filterKey);
  url.searchParams.set("filters[0][operator]", opts.operator);
  url.searchParams.append("filters[0][value][]", opts.value);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      Accept: "application/json",
    },
  });
  if (res.status === 429) throw new Error("RATE_LIMIT");
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`CF /logs ${res.status}: ${t}`);
  }
  return res.json<LogsListResponse>();
}

/** ===== Path builder ===== */
function pathForRow(prefix: string, createdAtISO: string, id: string): string {
  // Assumes createdAt is ISO (UTC)
  const d = new Date(createdAtISO);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${prefix}/dt=${yyyy}-${mm}-${dd}/hour=${hh}/${id}.jsonl`;
}

/** ===== Durable Object: Ingestor ===== */
export class Ingestor {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/run") return new Response("not found", { status: 404 });

    // Single execution lock (TTL should be about wall clock * 2)
    const lockExpiry = await this.state.storage.get<number>("lockExpiry");
    const now = Date.now();
    
    // Check if lock exists and hasn't expired
    if (lockExpiry && lockExpiry > now) {
      return new Response("locked", { status: 409 });
    }

    const MAX_WALL_MS = getInt(this.env.MAX_WALL_MS, 20000);
    const SAFETY_MS = getInt(this.env.SAFETY_MS, 1500);
    const lockExpiryTime = now + (MAX_WALL_MS * 2);

    await this.state.storage.put("lockExpiry", lockExpiryTime);

    try {
      const start = Date.now();
      const res = await this.runOnce(start);
      await this.state.storage.delete("lockExpiry");
      return new Response(JSON.stringify(res, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      await this.state.storage.delete("lockExpiry");
      return new Response(`ingest failed: ${e?.message || String(e)}`, { status: 500 });
    }
  }

  private async runOnce(startMs: number): Promise<{
    forward_pages: number;
    backfill_pages: number;
    uploaded: number;
    last_id: string;
  }> {
    const PER_PAGE = getInt(this.env.PER_PAGE, 50);
    const PARALLEL = getInt(this.env.PARALLEL_UPLOAD, 24);
    const BACKFILL_MIN = getInt(this.env.BACKFILL_MINUTES, 10);
    const MAX_WALL_MS = getInt(this.env.MAX_WALL_MS, 20000);
    const SAFETY_MS = getInt(this.env.SAFETY_MS, 1500);
    const MAX_PAGES_PER_RUN = getInt(this.env.MAX_PAGES_PER_RUN, 80);

    const limiter = pLimit(PARALLEL);
    const gcs = await getGcsAccessToken(this.env);

    // Get checkpoint (use minimum ULID if not exists)
    const cp = (await this.state.storage.get<Checkpoint>("cp")) ?? {
      lastId: MIN_ULID,
      updatedAt: nowIso(),
    };
    let lastId = cp.lastId;

    // 1) Forward phase: id > last_id
    let forwardPages = 0;
    let uploaded = 0;
    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      if (Date.now() - startMs > MAX_WALL_MS - SAFETY_MS) break;
      let json: LogsListResponse;
      try {
        json = await fetchLogsPage(this.env, {
          filterKey: "id",
          operator: "gt",
          value: lastId,
          page,
          perPage: PER_PAGE,
        });
      } catch (e: any) {
        if (String(e?.message || e) === "RATE_LIMIT") break; // Continue to next run
        throw e;
      }
      const items = json.result || [];
      if (!items.length) break;

      // Parallel upload
      await Promise.all(
        items.map((row: any) =>
          limiter(async () => {
            const id: string = row.id;
            const createdAt: string = row.created_at;
            const path = pathForRow(this.env.GCS_PREFIX, createdAt, id);
            const line = JSON.stringify(row) + "\n";
            await uploadJsonlCreateOnly(this.env, gcs.token, path, line);
          })
        )
      );

      uploaded += items.length;
      lastId = items[items.length - 1].id;
      forwardPages++;
      // Continue loop → next page
    }

    // Update checkpoint with forward results (last successful ID)
    await this.state.storage.put("cp", { lastId, updatedAt: nowIso() } as Checkpoint);

    // 2) Backfill: created_at >= now() - BACKFILL_MINUTES
    let backfillPages = 0;
    const sinceIso = new Date(Date.now() - BACKFILL_MIN * 60 * 1000).toISOString();
    for (let page = 1; page <= MAX_PAGES_PER_RUN; page++) {
      if (Date.now() - startMs > MAX_WALL_MS - SAFETY_MS) break;

      let json: LogsListResponse;
      try {
        json = await fetchLogsPage(this.env, {
          filterKey: "created_at",
          operator: "gte",
          value: sinceIso,
          page,
          perPage: PER_PAGE,
        });
      } catch (e: any) {
        if (String(e?.message || e) === "RATE_LIMIT") break;
        throw e;
      }
      const items = json.result || [];
      if (!items.length) break;

      await Promise.all(
        items.map((row: any) =>
          limiter(async () => {
            const id: string = row.id;
            const createdAt: string = row.created_at;
            const path = pathForRow(this.env.GCS_PREFIX, createdAt, id);
            const line = JSON.stringify(row) + "\n";
            await uploadJsonlCreateOnly(this.env, gcs.token, path, line);
          })
        )
      );

      uploaded += items.length;
      backfillPages++;
    }

    return { forward_pages: forwardPages, backfill_pages: backfillPages, uploaded, last_id: lastId };
  }
}

/** ===== Worker Entrypoints ===== */
export default {
  // Manual execution: /run
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      const id = env.INGESTOR.idFromName(env.CF_GATEWAY_ID);
      const stub = env.INGESTOR.get(id);
      return stub.fetch("http://do/run");
    }
    return new Response("ok");
  },

  // Cron
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const id = env.INGESTOR.idFromName(env.CF_GATEWAY_ID);
    const stub = env.INGESTOR.get(id);
    const res = await stub.fetch("http://do/run");
    if (!res.ok) {
      console.error("scheduled ingest failed:", res.status, await res.text());
    } else {
      console.log("scheduled ingest ok:", await res.text());
    }
  },
};

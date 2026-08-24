import type { FastifyRequest, FastifyReply } from 'fastify';

// Small in-memory response cache for hot GET endpoints (dashboard,
// lists summary, machine-status, packing progress). Keeps the last
// response for a short TTL keyed on URL + querystring, so repeated
// hits within the window skip the SQL round-trip entirely. This is
// the main reason page loads on the UI feel snappy even when the
// database is under heavy image-indexer / PLC-write pressure.
//
// Only for reads. Values are shared across all callers — do NOT put
// user-specific data through this.

interface CacheEntry {
  body: unknown;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();
// Last KNOWN-GOOD response per key, kept regardless of TTL. Lets a handler
// fall back to the most recent successful payload when a fresh recompute fails
// (e.g. the dashboard's SQL momentarily times out under image-indexer / PLC
// load) so the user sees slightly-stale numbers instead of an error banner.
const lastGood = new Map<string, unknown>();
const MAX_ENTRIES = 500;

// Drop every cached response. Called when the "demo hide" cutoff is toggled so
// hide/reveal takes effect immediately instead of after the TTL expires. Also
// clears the stale fallback so hidden data can't reappear via stale-on-error.
export function clearResponseCache(): void {
  store.clear();
  lastGood.clear();
  inFlight.clear();
}

// The most recent successful body for this request's URL, or undefined if we
// have never served a good response for it. Used for stale-on-error.
export function getStaleResponse(req: FastifyRequest): unknown | undefined {
  return lastGood.get(`${req.url}`);
}

// In-flight recompute per key, so concurrent misses coalesce into ONE query
// instead of a thundering herd (see getOrComputeSWR).
const inFlight = new Map<string, Promise<unknown>>();

// Stale-while-revalidate + single-flight for one expensive read.
//   - Fresh cache within TTL           -> return it, no DB work.
//   - Stale cache present              -> return stale IMMEDIATELY and refresh
//                                         once in the background (if not already).
//   - Cold (no cache)                  -> run a single coalesced compute and wait;
//                                         concurrent callers share that one promise.
//   - Compute throws                   -> fall back to stale / last-good if we have
//                                         it, else rethrow.
// This is what keeps the dashboard instant and error-free under load: at most
// one recompute per key runs at a time, and users never block on it once the
// cache is warm. SQL Server Express (few worker threads) is no longer swamped
// by N simultaneous dashboard recomputes.
export async function getOrComputeSWR<T>(
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const entry = store.get(key);
  const isFresh = entry !== undefined && entry.expiresAt > now;
  if (isFresh) return entry!.body as T;

  // Kick off (or join) a single background refresh for this key.
  if (!inFlight.has(key)) {
    const p = compute()
      .then((body) => {
        const t = Date.now();
        evictExpired(t);
        store.set(key, { body, expiresAt: t + ttlMs });
        if (lastGood.size >= MAX_ENTRIES) {
          const first = lastGood.keys().next().value;
          if (first !== undefined) lastGood.delete(first);
        }
        lastGood.set(key, body);
        return body as unknown;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, p);
  }
  const refresh = inFlight.get(key)!;

  // Stale-while-revalidate: if we have ANY prior body, serve it now and let the
  // refresh finish in the background. The caller never waits on the DB.
  const stale = entry?.body ?? lastGood.get(key);
  if (stale !== undefined) return stale as T;

  // Cold start: nothing to serve yet, so wait for the single in-flight compute.
  // If it fails and we still have nothing, the error propagates (genuine 500).
  try {
    return (await refresh) as T;
  } catch (err) {
    const fallback = lastGood.get(key);
    if (fallback !== undefined) return fallback as T;
    throw err;
  }
}

function evictExpired(now: number): void {
  if (store.size < MAX_ENTRIES) return;
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
  // If still full, drop the oldest half (rough LRU-ish).
  if (store.size >= MAX_ENTRIES) {
    const keys = Array.from(store.keys()).slice(0, Math.floor(MAX_ENTRIES / 2));
    for (const k of keys) store.delete(k);
  }
}

// Fastify preHandler factory — call with a TTL in ms. Attach on the
// route: `app.get('/dashboard', { preHandler: cacheReads(30_000) }, ...)`.
// On a cache hit, replies immediately and short-circuits the handler.
// On a miss, tags the request so the onSend hook records the response.
export function cacheReads(ttlMs: number) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (req.method !== 'GET') return;
    const key = `${req.url}`;
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expiresAt > now) {
      reply.header('X-Cache', 'HIT');
      reply.send(hit.body);
      return;
    }
    // Tag the request; onSend will write the response into the cache.
    (req as unknown as { _cacheKey?: string; _cacheTtl?: number })._cacheKey = key;
    (req as unknown as { _cacheKey?: string; _cacheTtl?: number })._cacheTtl = ttlMs;
  };
}

// onSend hook (registered globally in main.ts) that stores successful
// GET responses whose preHandler tagged them.
export function recordCacheOnSend(
  req: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): unknown {
  const key = (req as unknown as { _cacheKey?: string })._cacheKey;
  const ttl = (req as unknown as { _cacheTtl?: number })._cacheTtl;
  if (!key || !ttl) return payload;
  if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
  const now = Date.now();
  evictExpired(now);
  // payload comes in as string (Fastify has already serialized). Parse
  // back so a subsequent HIT can re-serialize cleanly.
  try {
    const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    store.set(key, { body, expiresAt: now + ttl });
    // Remember the last good body indefinitely (bounded) for stale-on-error.
    if (lastGood.size >= MAX_ENTRIES) {
      const first = lastGood.keys().next().value;
      if (first !== undefined) lastGood.delete(first);
    }
    lastGood.set(key, body);
  } catch {
    // non-JSON responses aren't cacheable
  }
  reply.header('X-Cache', 'MISS');
  return payload;
}

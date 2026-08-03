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
const MAX_ENTRIES = 500;

// Drop every cached response. Called when the "demo hide" cutoff is toggled so
// hide/reveal takes effect immediately instead of after the TTL expires.
export function clearResponseCache(): void {
  store.clear();
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
  } catch {
    // non-JSON responses aren't cacheable
  }
  reply.header('X-Cache', 'MISS');
  return payload;
}

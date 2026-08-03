import { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'crypto';
import { getHideBefore, setHideBefore, nowCutoff } from '../utils/hideState.js';
import { clearResponseCache } from '../utils/responseCache.js';

// Admin password verification — used by the Tool Life page on the
// Maintenance screen to gate edit/reset actions. Credentials live in
// docker-compose env vars (ADMIN_USERNAME / ADMIN_PASSWORD); the frontend
// keeps the "verified" state in-memory only (NOT localStorage) so closing
// the tab forces a re-auth.
//
// Why plaintext-in-env instead of bcrypt:
//   - one admin role, one password, single-host SCADA deployment
//   - the env file already holds the DB password
//   - rotation is `docker compose up -d backend` after editing .env
// If multi-user / per-user audit is ever needed, swap this for a real
// users table with bcrypt hashes — the frontend contract doesn't change.

function constantTimeEqual(a: string, b: string): boolean {
  // Equal-length strings only — pad to the longer one so both branches
  // do the same amount of work.
  const maxLen = Math.max(a.length, b.length);
  const ba = Buffer.alloc(maxLen, 0);
  const bb = Buffer.alloc(maxLen, 0);
  ba.write(a);
  bb.write(b);
  return timingSafeEqual(ba, bb) && a.length === b.length;
}

export default async function adminRoutes(app: FastifyInstance) {
  app.post<{ Body: { username?: string; password?: string } }>(
    '/admin/verify',
    async (req, reply) => {
      const expectedUsername = process.env.ADMIN_USERNAME ?? 'admin';
      const expectedPassword = process.env.ADMIN_PASSWORD ?? '';

      if (!expectedPassword) {
        // No password configured — fail closed. The deployment must set
        // ADMIN_PASSWORD in docker-compose env before this gate works.
        req.log.warn('[admin] verify called but ADMIN_PASSWORD is unset; denying');
        reply.status(503);
        return { ok: false, error: 'admin auth not configured' };
      }

      const username = String(req.body?.username ?? '');
      const password = String(req.body?.password ?? '');

      const userOk = constantTimeEqual(username, expectedUsername);
      const passOk = constantTimeEqual(password, expectedPassword);

      if (userOk && passOk) {
        req.log.info(`[admin] verify ok username=${username}`);
        return { ok: true };
      }

      // Always log auth failures so brute-force attempts show up in
      // `docker logs traceability-backend`. Don't echo the password.
      req.log.warn(`[admin] verify FAIL username='${username}'`);
      reply.status(401);
      return { ok: false };
    },
  );

  // ---------------------------------------------------------------------------
  // "Demo hide" — reversible, display-only clearing of the dashboard.
  // ---------------------------------------------------------------------------
  // hide:   set the cutoff to now -> Dashboard/Lists/Part Trace show only data
  //         from this instant forward. New production still appears live.
  // reveal: clear the cutoff -> ALL history reappears instantly.
  // Nothing is ever deleted; this only changes what the read queries show.
  //
  // These mutations are gated in the UI by the same admin login the Tool Life
  // actions use (requireAdmin) — matching this codebase's client-side gating
  // model where the /admin/verify check guards the control and the mutation
  // endpoint itself trusts the single-host LAN deployment.

  // Read the current toggle state — drives the app-wide "data hidden" banner.
  app.get('/admin/dashboard/state', async () => {
    const hideBefore = await getHideBefore();
    return { hidden: hideBefore !== null, hideBefore };
  });

  app.post('/admin/dashboard/hide', async (req) => {
    const hideBefore = await setHideBefore(nowCutoff());
    clearResponseCache();
    req.log.warn(`[admin] dashboard HIDE — cutoff=${hideBefore}`);
    return { ok: true, hidden: true, hideBefore };
  });

  app.post('/admin/dashboard/reveal', async (req) => {
    await setHideBefore(null);
    clearResponseCache();
    req.log.warn('[admin] dashboard REVEAL — all history visible again');
    return { ok: true, hidden: false, hideBefore: null };
  });
}

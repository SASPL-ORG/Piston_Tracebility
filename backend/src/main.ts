import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import healthRoutes from './routes/health.js';
import dashboardRoutes from './routes/dashboard.js';
import listRoutes from './routes/lists.js';
import partRoutes from './routes/parts.js';
import maintenanceRoutes from './routes/maintenance.js';
import licenseRoutes from './routes/license.js';
import imageRoutes from './routes/images.js';
import alarmRoutes from './routes/alarms.js';
import masterDataRoutes from './routes/masterData.js';
import toolLifeRoutes from './routes/toolLife.js';
import adminRoutes from './routes/admin.js';
import machineStatusRoutes from './routes/machineStatus.js';
import packingRoutes from './routes/packing.js';
import { recordCacheOnSend } from './utils/responseCache.js';
import { initHideState } from './utils/hideState.js';
import { isLicenseActive } from './license/license.js';
import { getPool, closePool, setConnectionLogger } from './db/connection.js';
import { startImageSubsystem, stopImageSubsystem } from './images/index.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

async function start() {
  await app.register(cors, { origin: true });

  // Load the reversible "demo hide" cutoff (display-only; nothing deleted) and
  // keep it refreshed so the query path can read it synchronously.
  initHideState();

  // Response cache — pairs with cacheReads() preHandlers on hot GETs.
  // The preHandler tags the request; this onSend writes the response
  // body into the shared cache so the next hit within the TTL is a
  // pure in-memory response (no SQL round-trip).
  app.addHook('onSend', async (req, reply, payload) => {
    return recordCacheOnSend(req, reply, payload) as string;
  });

  // License middleware - block all routes except license and health
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/license') || url.startsWith('/health')) return;
    if (!isLicenseActive()) {
      reply.status(403).send({ error: 'unlicensed' });
    }
  });

  // Register routes
  await app.register(licenseRoutes);
  await app.register(healthRoutes);
  await app.register(dashboardRoutes);
  await app.register(listRoutes);
  await app.register(partRoutes);
  await app.register(maintenanceRoutes);
  await app.register(imageRoutes);
  await app.register(alarmRoutes);
  await app.register(masterDataRoutes);
  await app.register(toolLifeRoutes);
  await app.register(adminRoutes);
  await app.register(machineStatusRoutes);
  await app.register(packingRoutes);

  // Wire the SQL connection module to fastify's logger so its retry
  // attempts show up in `docker logs traceability-backend` alongside
  // the rest of the startup output.
  setConnectionLogger({
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
    error: (m) => app.log.error(m),
  });

  // Start HTTP server FIRST so /health is reachable even while the
  // SQL pool is still connecting. This is what makes the
  // docker-compose healthcheck meaningful: a slow-booting SQL Server
  // no longer puts the container into a "starting forever" state.
  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Server running on port ${port}`);

  // Start the SQL pool and image subsystem in the background — both
  // have their own retry-with-backoff loops, so this won't block.
  // If SQL Server is still booting we keep the HTTP server up; calls
  // to dashboard/list/etc. will fail with their own 500s until SQL is
  // ready, while /health correctly reports `degraded` in the meantime.
  void (async () => {
    try {
      await getPool();   // blocks until SQL connect succeeds
      app.log.info('Database connected successfully');
    } catch (err) {
      // getPool() retries internally and shouldn't throw, but if it
      // ever does we want to know.
      app.log.error('Database connect loop exited with: ' + (err as Error).message);
      return;
    }

    // Image subsystem requires DB. It also has its own retry loop for
    // the bind-mount path.
    try {
      await startImageSubsystem({
        info: (m) => app.log.info(m),
        warn: (m) => app.log.warn(m),
        error: (m) => app.log.error(m),
      });
    } catch (err) {
      app.log.error('Image subsystem failed to start: ' + (err as Error).message);
    }
  })();

  // Log license status
  if (isLicenseActive()) {
    app.log.info('License: ACTIVE');
  } else {
    app.log.warn('License: NOT ACTIVATED - app is locked');
  }
}

async function shutdown() {
  app.log.info('Shutting down...');
  await stopImageSubsystem().catch(() => undefined);
  await app.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import healthRoutes from './routes/health.js';
import dashboardRoutes from './routes/dashboard.js';
import listRoutes from './routes/lists.js';
import partRoutes from './routes/parts.js';
import maintenanceRoutes from './routes/maintenance.js';
import licenseRoutes from './routes/license.js';
import { isLicenseActive } from './license/license.js';
import { getPool, closePool } from './db/connection.js';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
});

async function start() {
  await app.register(cors, { origin: true });

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

  // Test DB connection on startup
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1');
    app.log.info('Database connected successfully');
  } catch (err) {
    app.log.error('Database connection failed: %s', (err as Error).message);
  }

  // Log license status
  if (isLicenseActive()) {
    app.log.info('License: ACTIVE');
  } else {
    app.log.warn('License: NOT ACTIVATED - app is locked');
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`Server running on port ${port}`);
}

async function shutdown() {
  app.log.info('Shutting down...');
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

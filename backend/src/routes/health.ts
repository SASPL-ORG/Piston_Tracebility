import { FastifyInstance } from 'fastify';
import { getPool } from '../db/connection.js';

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    try {
      const pool = await getPool();
      await pool.request().query('SELECT 1');
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch {
      reply.status(503);
      return { status: 'degraded', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  });
}

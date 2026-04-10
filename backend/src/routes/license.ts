import { FastifyInstance } from 'fastify';
import { getLicenseInfo, activateLicense } from '../license/license.js';

export default async function licenseRoutes(app: FastifyInstance) {
  app.get('/license/status', async () => {
    return getLicenseInfo();
  });

  app.post<{ Body: { key: string } }>('/license/activate', async (req, reply) => {
    const { key } = req.body || {};
    if (!key || typeof key !== 'string') {
      reply.status(400);
      return { success: false, error: 'License key is required' };
    }

    const result = activateLicense(key.trim());
    if (!result.success) {
      reply.status(400);
    }
    return result;
  });
}

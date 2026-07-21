import { FastifyInstance } from 'fastify';
import { getConnectionStatus } from '../db/connection.js';
import { getImageWatcherStatus } from '../images/watcher.js';

// Health endpoint surfaces the real state of the two critical subsystems
// (SQL pool, image watcher). Used by the docker-compose healthcheck and
// by anyone debugging "the dashboard is blank after a reboot."
//
// Status is `ok` iff:
//   • SQL is currently connected, AND
//   • image watcher is running.
// Otherwise `degraded` (HTTP 200 still — `degraded` is reportable health,
// not a 5xx). A docker-compose healthcheck looking at the HTTP status
// alone passes whenever the server itself is responding; the body
// communicates the finer details.
export default async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    const sql = getConnectionStatus();
    const watcher = getImageWatcherStatus();
    const status: 'ok' | 'degraded' =
      sql.connected && watcher.running ? 'ok' : 'degraded';
    return {
      status,
      timestamp: new Date().toISOString(),
      sql: {
        connected: sql.connected,
        lastConnectAt: sql.lastConnectAt,
        lastErrorAt: sql.lastErrorAt,
        lastErrorMsg: sql.lastErrorMsg,
        host: sql.host,
      },
      imageWatcher: {
        running: watcher.running,
        path: watcher.path,
        lastFileAt: watcher.lastFileAt,
        totalProcessed: watcher.totalProcessed,
      },
    };
  });
}

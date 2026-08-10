import { FastifyInstance } from 'fastify';
import { getConnectionStatus } from '../db/connection.js';
import { getImageWatcherStatus } from '../images/watcher.js';
import { countPendingImages } from '../images/db.js';

// Above this many images waiting for their inspection row, the image
// pipeline is considered backlogged (rows not being written fast enough —
// usually a Node-RED/PLC issue). Surfaced so it's caught in hours, not days.
const IMAGE_BACKLOG_WARN = Number(process.env.IMAGE_BACKLOG_WARN ?? 500);

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
    // Best-effort — never let the pile-up probe fail the whole health check.
    let pending = 0;
    let pendingKnown = false;
    if (sql.connected) {
      try {
        pending = await countPendingImages();
        pendingKnown = true;
      } catch {
        /* leave pending=0, pendingKnown=false */
      }
    }
    const backlogged = pendingKnown && pending > IMAGE_BACKLOG_WARN;
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
        // Pile-up signal: images waiting for their inspection row.
        pendingImages: pendingKnown ? pending : null,
        backlogged,
      },
    };
  });
}

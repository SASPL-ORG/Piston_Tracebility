import chokidar, { FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import { getImageConfig } from './config.js';
import { indexImage } from './indexer.js';

let watcher: FSWatcher | null = null;
// Serialize indexImage calls — DB writes don't tolerate concurrent next-picture-no
// races on the same (DMC, type, ring_count) bucket without explicit locking.
let queue: Promise<void> = Promise.resolve();

function enqueue(filePath: string): void {
  queue = queue
    .catch(() => undefined)
    .then(() =>
      indexImage(filePath).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[images] indexImage failed for', filePath, (err as Error).message);
      }),
    );
}

export async function startImageWatcher(
  log: (msg: string) => void,
): Promise<FSWatcher | null> {
  const cfg = getImageConfig();

  // Don't crash the backend if the source path isn't bind-mounted yet.
  try {
    await fs.access(cfg.incomingPath);
  } catch {
    log(
      `[images] incoming path not accessible (${cfg.incomingPath}); ` +
        'skipping watcher. Ensure the bind-mount in docker-compose.yml is in place.',
    );
    return null;
  }

  watcher = chokidar.watch(cfg.incomingPath, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 200,
    },
    depth: 4,
    usePolling: cfg.watchUsePolling,
    interval: 1000,
    binaryInterval: 1500,
    // Only react to image files; the CV-X folder may contain meta files.
    ignored: (path: string) => {
      if (path === cfg.incomingPath) return false;
      // Ignore directories (chokidar passes them through too).
      if (!/\.(jpg|bmp)$/i.test(path)) {
        // Permit directories so recursion still works.
        return /\.[a-z0-9]+$/i.test(path);
      }
      return false;
    },
  });

  watcher.on('add', (filePath) => enqueue(filePath));
  watcher.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[images] watcher error', (err as Error).message);
  });

  log(
    `[images] watching ${cfg.incomingPath} ` +
      `(polling=${cfg.watchUsePolling}, file_handling=${cfg.fileHandling})`,
  );
  return watcher;
}

export async function stopImageWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
  }
}

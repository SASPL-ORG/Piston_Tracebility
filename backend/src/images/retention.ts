import { promises as fs } from 'fs';
import path from 'path';
import { getImageConfig } from './config.js';
import { findExpiredImages, deleteImageRow } from './db.js';
import { logAlarm } from './alarms.js';

// Deletes rows + files older than IMAGE_RETENTION_DAYS. File-missing-on-disk
// is non-fatal — drop the orphan row regardless. Logs a single summary alarm.
export async function runRetention(): Promise<{
  deleted: number;
  fileErrors: number;
}> {
  const cfg = getImageConfig();
  const expired = await findExpiredImages(cfg.retentionDays);

  let deleted = 0;
  let fileErrors = 0;

  const thumbDir = path.join(cfg.outputPath, '__thumbs');

  for (const row of expired) {
    try {
      await fs.unlink(row.file_path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') fileErrors++;
    }
    // Best-effort cleanup of the cached thumbnail. ENOENT is fine — many
    // images never have their thumb generated.
    await fs
      .unlink(path.join(thumbDir, `${row.id}.jpg`))
      .catch(() => undefined);
    try {
      await deleteImageRow(row.id);
      deleted++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[images] retention row delete failed for id', row.id, (err as Error).message);
    }
  }

  await logAlarm('IMAGE_RETENTION_RUN', null, 'IMAGE', {
    retentionDays: cfg.retentionDays,
    deleted,
    fileErrors,
  });
  return { deleted, fileErrors };
}

// True if `dir` contains any file anywhere beneath it. On a read error we
// return true (treat as non-empty) so we NEVER delete a folder we couldn't
// fully inspect.
async function hasAnyFile(dir: string, depth: number): Promise<boolean> {
  if (depth > 6) return false;
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of ents) {
    if (e.isFile()) return true;
    if (e.isDirectory() && (await hasAnyFile(path.join(dir, e.name), depth + 1))) return true;
  }
  return false;
}

// Prunes stale, EMPTY per-part session folders from /data/incoming. The CV-X
// creates one folder per part; once the image is moved to the output store the
// incoming folder is left empty, and these accumulate into the 100k+ range,
// which used to choke the scanner. Only folders that are BOTH older than
// IMAGE_INCOMING_PRUNE_DAYS (default 2) AND contain zero files (recursively)
// are removed — so no image data can ever be lost and in-progress/recent
// folders are never touched. Runs once daily alongside retention.
export async function pruneEmptyIncomingFolders(): Promise<{ scanned: number; removed: number }> {
  const cfg = getImageConfig();
  const pruneDays = Math.max(parseInt(process.env.IMAGE_INCOMING_PRUNE_DAYS || '2', 10), 1);
  const cutoff = Date.now() - pruneDays * 86400_000;
  let scanned = 0;
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(cfg.incomingPath, { withFileTypes: true });
  } catch {
    return { scanned, removed };
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !/^\d{6}_\d{6}$/.test(ent.name)) continue;
    const p = path.join(cfg.incomingPath, ent.name);
    scanned++;
    let mt = 0;
    try {
      mt = (await fs.stat(p)).mtimeMs;
    } catch {
      continue;
    }
    if (mt >= cutoff) continue; // recent / possibly in-progress — leave it
    if (await hasAnyFile(p, 0)) continue; // has images — NEVER delete
    try {
      await fs.rm(p, { recursive: true, force: true });
      removed++;
    } catch {
      // ignore — a folder that reappears next run is harmless
    }
  }
  return { scanned, removed };
}

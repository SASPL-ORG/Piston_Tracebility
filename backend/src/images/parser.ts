import { promises as fs } from 'fs';
import path from 'path';
import { getImageConfig } from './config.js';

export interface ParsedImage {
  dmcSuffix: string;
  fullDmc: string;
  okFlag: 0 | 1;
  cameraId: string;
  sourceCounter: number;
  sessionFolder: string;
  inspectionType: 'CIRCLIP' | 'RING';
  filePath: string;
  capturedAt: Date;
}

// {DMC_SUFFIX}_{OK_FLAG}_CAM{N}_{10-digit counter}.{jpg|bmp}
// DMC_SUFFIX is the variable portion (camera strips the static prefix).
// Greedy on the suffix; the trailing structure is rigid so backtracking
// resolves the boundary unambiguously.
const FILENAME_PATTERN = /^(.+)_(\d)_(CAM\d+)_(\d{10})\.(jpg|bmp)$/i;

// Returns null on any failure (unrecognized name, missing file, unknown CAM).
// Caller should log an IMAGE_PARSE_FAIL alarm on null.
export async function parseImagePath(filePath: string): Promise<ParsedImage | null> {
  const cfg = getImageConfig();
  const basename = path.basename(filePath);
  const m = basename.match(FILENAME_PATTERN);
  if (!m) return null;

  const [, dmcSuffix, okStr, cameraId, counterStr] = m;
  const okFlag = okStr === '0' ? 0 : 1;
  const sourceCounter = parseInt(counterStr, 10);
  if (!Number.isFinite(sourceCounter)) return null;

  const inspectionType = cfg.camToType[cameraId];
  if (!inspectionType) return null;

  // Session folder is two directories above the file:
  // .../incoming/<session>/<CAM>/<judgment>/<file>
  // Best-effort — falls back to '' if the file is at an unexpected depth.
  const segments = filePath.split(path.sep).filter((s) => s.length > 0);
  const sessionFolder = segments.length >= 4 ? segments[segments.length - 4] : '';

  let capturedAt: Date;
  try {
    const stat = await fs.stat(filePath);
    capturedAt = stat.mtime;
  } catch {
    return null;
  }

  return {
    dmcSuffix,
    fullDmc: cfg.dmcStaticPrefix + dmcSuffix,
    okFlag,
    cameraId,
    sourceCounter,
    sessionFolder,
    inspectionType,
    filePath,
    capturedAt,
  };
}

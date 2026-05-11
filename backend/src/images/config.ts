// Centralized env-driven configuration for the image subsystem.
// Defaults match spec 08_image_system_spec_v3.md §3 (locked decisions).

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

export interface ImageConfig {
  incomingPath: string;
  outputPath: string;
  dmcStaticPrefix: string;
  camToType: Record<string, 'CIRCLIP' | 'RING'>;
  expectedRingPictures: number;
  expectedCirclipPictures: number;
  matchToleranceSeconds: number;
  // Small forward-slack: how many seconds the image's mtime is allowed to
  // be EARLIER than the SAM_Log Ring_Time / Circlip_Time. Handles the edge
  // case where CV-X writes a file slightly before the PLC logs the
  // inspection result. Should be much smaller than the typical interval
  // between consecutive attempts so re-inspections don't cross-pollinate.
  matchPreToleranceSeconds: number;
  pendingTimeoutMinutes: number;
  retentionDays: number;
  fileHandling: 'move' | 'copy';
  watchUsePolling: boolean;
}

let cached: ImageConfig | null = null;

export function getImageConfig(): ImageConfig {
  if (cached) return cached;

  const ringCam = process.env.CAM_RING || 'CAM1';
  const circlipCam = process.env.CAM_CIRCLIP || 'CAM2';
  const fileHandlingRaw = (process.env.IMAGE_FILE_HANDLING || 'move').toLowerCase();
  const fileHandling: 'move' | 'copy' = fileHandlingRaw === 'copy' ? 'copy' : 'move';

  cached = {
    incomingPath: process.env.INCOMING_IMAGES_PATH || '/data/incoming',
    outputPath: process.env.IMAGES_OUTPUT_PATH || '/data/images',
    dmcStaticPrefix: process.env.DMC_STATIC_PREFIX || '[)>.06-VTH16-P234102',
    camToType: {
      [ringCam]: 'RING',
      [circlipCam]: 'CIRCLIP',
    },
    expectedRingPictures: envInt('EXPECTED_RING_PICTURES_PER_ATTEMPT', 25),
    expectedCirclipPictures: envInt('EXPECTED_CIRCLIP_PICTURES_PER_ATTEMPT', 1),
    matchToleranceSeconds: envInt('IMAGE_MATCH_TOLERANCE_SECONDS', 300),
    matchPreToleranceSeconds: envInt('IMAGE_MATCH_PRE_TOLERANCE_SECONDS', 60),
    pendingTimeoutMinutes: envInt('IMAGE_PENDING_TIMEOUT_MINUTES', 15),
    retentionDays: envInt('IMAGE_RETENTION_DAYS', 365),
    fileHandling,
    // Default true on Linux containers reading Windows bind-mounts: inotify
    // does not propagate reliably across the boundary. Override with
    // IMAGE_WATCH_USE_POLLING=false if you confirm native events work.
    watchUsePolling: envBool('IMAGE_WATCH_USE_POLLING', true),
  };
  return cached;
}

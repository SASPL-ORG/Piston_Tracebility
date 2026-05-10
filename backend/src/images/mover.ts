import { promises as fs } from 'fs';
import path from 'path';
import { getImageConfig } from './config.js';

// DMCs commonly contain `>` (and may contain `<`, `:`, `"`, `|`, `?`, `*`)
// which are illegal in Windows file/directory names. Inside the Linux
// container the path is fine, but the destination volume is bind-mounted
// from a Windows host where Explorer/PowerShell cannot traverse those names.
// Replace each offender with `_` for the on-disk path only — the DMC stored
// in dbo.Image_Index and returned by the API is unchanged.
function sanitizeForWindowsFs(s: string): string {
  return s.replace(/[<>:"|?*]/g, '_');
}

// Moves (or copies, per env) a parsed source file into the destination
// hierarchy:  <output>/<DMC>/<CIRCLIP|RING>/attempt_<N>/<OK|NG>/<basename>
//
// Falls back to copy+unlink on EXDEV (the two paths are separate bind-mounts
// inside the container even though they live on the same Windows drive).
export async function moveFileToDestination(args: {
  sourcePath: string;
  fullDmc: string;
  inspectionType: 'CIRCLIP' | 'RING';
  ringCount: number | null;
  okFlag: 0 | 1;
}): Promise<string> {
  const cfg = getImageConfig();

  const attemptLabel = args.ringCount === null ? 'attempt_1' : `attempt_${args.ringCount}`;
  const okLabel = args.okFlag === 0 ? 'OK' : 'NG';

  const destDir = path.join(
    cfg.outputPath,
    sanitizeForWindowsFs(args.fullDmc),
    args.inspectionType,
    attemptLabel,
    okLabel,
  );
  await fs.mkdir(destDir, { recursive: true });

  const destPath = path.join(destDir, path.basename(args.sourcePath));

  if (cfg.fileHandling === 'copy') {
    await fs.copyFile(args.sourcePath, destPath);
    return destPath;
  }

  try {
    await fs.rename(args.sourcePath, destPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV' || code === 'EPERM') {
      // Cross-filesystem — fall back to copy + delete.
      await fs.copyFile(args.sourcePath, destPath);
      await fs.unlink(args.sourcePath);
    } else {
      throw err;
    }
  }
  return destPath;
}

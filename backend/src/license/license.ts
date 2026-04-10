import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const LICENSE_SECRET = 'SYMBIOTIC_PISTON_TRACE_2026_KEY';
const LICENSE_FILE = process.env.LICENSE_PATH || '/data/license/license.json';

interface LicenseData {
  key: string;
  client: string;
  activated_at: string;
}

let cachedLicense: LicenseData | null = null;
let cacheValid = false;

function generateHmac(clientId: string): string {
  return crypto.createHmac('sha256', LICENSE_SECRET).update(clientId).digest('hex');
}

export function verifyLicenseKey(key: string): { valid: boolean; client: string } {
  const dotIndex = key.lastIndexOf('.');
  if (dotIndex === -1) return { valid: false, client: '' };

  const clientId = key.substring(0, dotIndex);
  const signature = key.substring(dotIndex + 1);

  if (!clientId || !signature) return { valid: false, client: '' };

  const expected = generateHmac(clientId);
  const isValid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  );

  return { valid: isValid, client: clientId };
}

export function isLicenseActive(): boolean {
  if (cacheValid && cachedLicense) return true;

  try {
    if (!fs.existsSync(LICENSE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf-8')) as LicenseData;
    const { valid } = verifyLicenseKey(data.key);
    if (valid) {
      cachedLicense = data;
      cacheValid = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function getLicenseInfo(): { licensed: boolean; client?: string; activated_at?: string } {
  if (!isLicenseActive()) return { licensed: false };
  return {
    licensed: true,
    client: cachedLicense!.client,
    activated_at: cachedLicense!.activated_at,
  };
}

export function activateLicense(key: string): { success: boolean; error?: string; client?: string } {
  const { valid, client } = verifyLicenseKey(key);
  if (!valid) return { success: false, error: 'Invalid license key' };

  const data: LicenseData = {
    key,
    client,
    activated_at: new Date().toISOString(),
  };

  try {
    const dir = path.dirname(LICENSE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(data, null, 2));
    cachedLicense = data;
    cacheValid = true;
    return { success: true, client };
  } catch (err) {
    return { success: false, error: `Failed to save license: ${(err as Error).message}` };
  }
}

export function deactivateLicense(): boolean {
  try {
    if (fs.existsSync(LICENSE_FILE)) fs.unlinkSync(LICENSE_FILE);
    cachedLicense = null;
    cacheValid = false;
    return true;
  } catch {
    return false;
  }
}

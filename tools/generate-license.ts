import crypto from 'crypto';

const LICENSE_SECRET = 'SYMBIOTIC_PISTON_TRACE_2026_KEY';

function generateLicenseKey(clientId: string): string {
  const signature = crypto.createHmac('sha256', LICENSE_SECRET).update(clientId).digest('hex');
  return `${clientId}.${signature}`;
}

// CLI usage
const clientId = process.argv[2];

if (!clientId) {
  console.log('');
  console.log('  Symbiotic License Key Generator');
  console.log('  ================================');
  console.log('');
  console.log('  Usage: npx tsx generate-license.ts <ClientName>');
  console.log('');
  console.log('  Examples:');
  console.log('    npx tsx generate-license.ts ACME-Corp');
  console.log('    npx tsx generate-license.ts "Toyota Plant-3"');
  console.log('    npx tsx generate-license.ts TestClient');
  console.log('');
  process.exit(1);
}

const key = generateLicenseKey(clientId);

console.log('');
console.log('  License Key Generated');
console.log('  =====================');
console.log(`  Client:  ${clientId}`);
console.log(`  Key:     ${key}`);
console.log('');
console.log('  Share this key with the client to activate their Piston Traceability instance.');
console.log('');

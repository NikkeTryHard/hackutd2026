import { unzipSync, strFromU8 } from 'fflate';
import { resolve } from 'node:path';

const path = Bun.argv[2] || resolve(Bun.env.DATA_DIR || './data', 'smoke', 'report.zip');
const archive = unzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()));
const checksumsEntry = Object.entries(archive).find(([name]) =>
  /(?:sha256sums\.txt|SHA256SUMS)$/.test(name),
);
if (checksumsEntry) {
  const rows = strFromU8(checksumsEntry[1]).trim().split('\n');
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) throw new Error('Malformed SHA-256 manifest row');
    const expected = match[1];
    const name = match[2];
    if (!expected || !name) throw new Error('Incomplete SHA-256 manifest row');
    const bytes = archive[name];
    if (!bytes) throw new Error(`Missing artifact ${name}`);
    const actual = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`Checksum mismatch for ${name}`);
  }
  console.log(`Verified ${rows.length} SHA-256 checksums`);
} else {
  const manifestEntry = archive['manifest.json'];
  if (!manifestEntry) throw new Error('Bundle contains no integrity manifest');
  const manifest: unknown = JSON.parse(strFromU8(manifestEntry));
  console.log(
    'Bundle has manifest.json; inspect its declared checksum format:',
    JSON.stringify(manifest),
  );
  process.exitCode = 1;
}

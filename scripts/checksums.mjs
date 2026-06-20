// Produces SHA-256 checksums for every artifact in release/, written to
// checksums.txt. Sign that file out-of-band with minisign or cosign so
// "this binary matches the public source" is independently verifiable:
//
//   minisign -Sm checksums.txt
//
// This is the publishable, signable manifest the update checker verifies.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const releaseDir = join(process.cwd(), 'release');
if (!existsSync(releaseDir)) {
  console.error('No release/ directory — run `npm run dist` first.');
  process.exit(1);
}

const lines = [];
for (const name of readdirSync(releaseDir).sort()) {
  const full = join(releaseDir, name);
  if (!statSync(full).isFile()) continue;
  const hash = createHash('sha256').update(readFileSync(full)).digest('hex');
  lines.push(`${hash}  ${name}`);
}

writeFileSync(join(process.cwd(), 'checksums.txt'), lines.join('\n') + '\n');
console.log(`Wrote checksums.txt for ${lines.length} artifact(s).`);

// Builds the Harbor Windows installer.
//
// Two steps, neither of which needs wine:
//   1. electron-builder --win dir   → release/win-unpacked (the packaged app)
//   2. makensis build/installer.nsi → release/Harbor-Setup-<version>.exe
//
// Run `npm run installer`. Requires `makensis` on PATH (Debian/Ubuntu:
// `apt-get install nsis`; macOS: `brew install makensis`). On Windows, prefer
// `npm run dist` (electron-builder's own NSIS) instead.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = pkg.version;

const srcDir = join(root, 'release', 'win-unpacked');
const outFile = join(root, 'release', `Harbor-Setup-${version}.exe`);
const nsi = join(root, 'build', 'installer.nsi');
const iconFile = join(root, 'build', 'icon.ico');

if (!existsSync(srcDir)) {
  console.log('release/win-unpacked not found — packaging the app first…');
  execFileSync('npx', ['electron-builder', '--win', 'dir', '--x64'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
}

console.log('Compiling installer with makensis…');
execFileSync(
  'makensis',
  [`-DSRCDIR=${srcDir}`, `-DOUTFILE=${outFile}`, `-DVERSION=${version}`, `-DICONFILE=${iconFile}`, nsi],
  { cwd: root, stdio: 'inherit' },
);
console.log(`\nInstaller written to ${outFile}`);

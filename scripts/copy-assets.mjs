// Copies the renderer's static assets (HTML/CSS) into the build output. The
// renderer's TypeScript is compiled by tsc; only these non-TS files need copying.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'renderer');
const dest = join(root, 'dist', 'renderer');

mkdirSync(dest, { recursive: true });
for (const file of ['index.html', 'styles.css', 'newtab.html']) {
  cpSync(join(src, file), join(dest, file));
}
// Runtime window/taskbar icon, loaded by the main process at window creation.
cpSync(join(root, 'build', 'icon.png'), join(root, 'dist', 'icon.png'));
console.log('Copied renderer assets to dist/renderer');

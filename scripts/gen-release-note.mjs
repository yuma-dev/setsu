// bakes the personal note from RELEASE_NOTE.md (written by release:preview) into the renderer
// build, KofiNote.tsx shows it after people update. the version goes with it so a note left over
// from an older build never shows on a newer one. no file or an empty note means the default text
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'src', 'renderer', 'release-note.generated.json');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

export function readReleaseNote() {
  let raw = '';
  try {
    raw = readFileSync(path.join(root, 'RELEASE_NOTE.md'), 'utf8');
  } catch {
    return '';
  }
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = readReleaseNote();
  writeFileSync(outPath, `${JSON.stringify({ version, text })}\n`);
  console.log(`gen-release-note: ${text ? `note for v${version} embedded` : 'no note, the app shows the default'}`);
}

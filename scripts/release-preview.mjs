import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateChangelog } from './changelog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version, lastTag, body } = generateChangelog(root);
const draftFile = join(root, 'RELEASE_DRAFT.md');
const noteFile = join(root, 'RELEASE_NOTE.md');

writeFileSync(draftFile, `${body}\n`, 'utf8');
// kept across re-runs, it's typed by hand
if (!existsSync(noteFile)) {
  writeFileSync(
    noteFile,
    `<!-- personal note for v${version}, shows bottom right next to your avatar after people update.
it already starts with "Hey, " so start mid sentence. blank lines make paragraphs.
leave it empty and the app says the default line instead. -->

`,
    'utf8',
  );
}

console.log(`\nRelease notes preview - v${version} (since ${lastTag ?? 'beginning'})\n`);
console.log('-'.repeat(50));
console.log(body);
console.log('-'.repeat(50));
console.log('\nEdit RELEASE_DRAFT.md to make changes, then run: npm run release');
console.log('Write the in-app note to your users in RELEASE_NOTE.md, or leave it empty for the default.');
console.log('To regenerate from scratch, delete RELEASE_DRAFT.md and re-run this command.\n');

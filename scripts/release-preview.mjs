import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateChangelog } from './changelog.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version, lastTag, body } = generateChangelog(root);
const draftFile = join(root, 'RELEASE_DRAFT.md');

writeFileSync(draftFile, `${body}\n`, 'utf8');

console.log(`\nRelease notes preview - v${version} (since ${lastTag ?? 'beginning'})\n`);
console.log('-'.repeat(50));
console.log(body);
console.log('-'.repeat(50));
console.log('\nEdit RELEASE_DRAFT.md to make changes, then run: npm run release');
console.log('To regenerate from scratch, delete RELEASE_DRAFT.md and re-run this command.\n');

if (process.argv.includes('--no-designer')) process.exit(0);

// the in-app note is written in the designer and published to the feed repo, not baked in.
// the dev app shares the installed app's single-instance lock, so Setsu has to be closed
console.log(`Starting the dev app in the message designer with a draft note for v${version}.`);
console.log('Close the installed Setsu first if it is running. Skip this with --no-designer.\n');
const child = spawn('npm', ['run', 'dev'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, SETSU_DESIGNER: version },
});
child.on('exit', (code) => process.exit(code ?? 0));

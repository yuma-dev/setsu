// Copies the native splash launcher into vendor/launcher/"Setsu Launcher.exe"
// for electron-builder to place at the install root next to Setsu.exe. renaming Setsu.exe
// makes the update unpin the app (3.7.0 took that hit once for the Setsu rename).
// Launcher starts Setsu.exe and fades out once its window is on screen.
// Run via `npm run vendor:launcher` (or as part of `npm run build`).
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");
const exe = join(repo, "clipdip", "target", "release", "cliplib-launcher.exe");
// read from resources/ next to the exe since 3.8.2, it used to be baked into the exe
const splash = join(repo, "clipdip", "crates", "launcher", "splash.bin");
const outDir = join(repo, "vendor", "launcher");

if (!existsSync(exe)) {
  console.error(`vendor-launcher: missing ${exe}`);
  console.error("Build it first: npm run build:launcher");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const dest = join(outDir, "Setsu Launcher.exe");
copyFileSync(exe, dest);
if (existsSync(splash)) copyFileSync(splash, join(outDir, "launcher-splash.bin"));
else console.warn("vendor-launcher: no splash.bin (npm run bake:splash), the launcher will start the app without it");
console.log(`vendor-launcher: Setsu Launcher.exe (${(statSync(dest).size / 1024).toFixed(0)} KB) -> ${outDir}`);

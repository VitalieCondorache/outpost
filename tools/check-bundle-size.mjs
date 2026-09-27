#!/usr/bin/env node
/**
 * Bundle budget.
 *
 * Local-first apps are easy to bloat: every helper "just adds 3 kB". This script
 * keeps that honest without pulling in a bundler-analyser dependency — it gzips
 * the production output with Node's own zlib and fails over the budget.
 *
 * Usage:
 *   npm run build && npm run size
 *   BUNDLE_BUDGET_KB=95 npm run size     # tighten it locally
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ASSETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../app/dist/assets');
const BUDGET_KB = Number(process.env.BUNDLE_BUDGET_KB ?? 110);

function files(directory) {
  return readdirSync(directory).filter((file) => /\.(js|css)$/.test(file));
}

function main() {
  if (!statSync(ASSETS_DIR, { throwIfNoEntry: false })) {
    console.error(`no build found in ${ASSETS_DIR} — run \`npm run build\` first`);
    process.exitCode = 1;
    return;
  }

  const rows = files(ASSETS_DIR)
    .map((file) => {
      const raw = readFileSync(join(ASSETS_DIR, file));
      return { file, raw: raw.byteLength, gzip: gzipSync(raw).byteLength };
    })
    .sort((a, b) => b.gzip - a.gzip);

  const totalGzip = rows.reduce((sum, row) => sum + row.gzip, 0);
  const totalRaw = rows.reduce((sum, row) => sum + row.raw, 0);

  for (const row of rows) {
    console.log(
      `${row.file.padEnd(34)} ${(row.raw / 1024).toFixed(1).padStart(8)} kB raw` +
        `${(row.gzip / 1024).toFixed(1).padStart(9)} kB gzip`,
    );
  }
  console.log(
    `${'total'.padEnd(34)} ${(totalRaw / 1024).toFixed(1).padStart(8)} kB raw` +
      `${(totalGzip / 1024).toFixed(1).padStart(9)} kB gzip`,
  );

  const totalKb = totalGzip / 1024;
  if (totalKb > BUDGET_KB) {
    console.error(`\n❌ bundle budget exceeded: ${totalKb.toFixed(1)} kB > ${BUDGET_KB} kB`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n✅ ${totalKb.toFixed(1)} kB gzip, budget ${BUDGET_KB} kB`);
}

main();

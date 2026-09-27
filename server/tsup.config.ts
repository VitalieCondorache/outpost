import { defineConfig } from 'tsup';

/**
 * The API is bundled to a single ESM file, so the Docker image only needs
 * `node_modules` for Hono and nothing else.
 *
 * `removeNodeProtocol: false` is not cosmetic. tsup strips the `node:` prefix
 * from every builtin import by default, which turns
 * `import { DatabaseSync } from 'node:sqlite'` into `from 'sqlite'` — a package
 * that does not exist, so the built bundle cannot even start on Node 22+.
 * The end-to-end suite boots `server/dist/index.js`, so this regression is
 * covered by a test.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  removeNodeProtocol: false,
  // `@outpost/shared` is a devDependency on purpose: its types are inlined here
  // instead of being resolved at runtime.
});

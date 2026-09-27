#!/usr/bin/env node
/**
 * Independent check of the hand-written GIF encoder in `lib/gif.mjs`.
 *
 * The unit tests decode the encoder's own bytes with a decoder that lives in this
 * repository, so a misunderstanding shared by both sides passes them both. This
 * probe writes a bitmap built to make corruption obvious — four flat bands plus a
 * checkerboard — and the point is to open the result with something that shares no
 * code with us: a browser, Quick Look, any image editor.
 *
 *   npm run probe:gif              # → /tmp/outpost-gif-probe.gif
 *   npm run probe:gif out.gif      # → ./out.gif
 *
 * The bitmap is 240×160 with 64 colours: small enough to eyeball, varied enough
 * that the encoder has to grow and re-width its dictionary while writing it. That
 * is where the bug in `docs/engineering-notes.md` §7 lived, and it was this probe
 * — 99.9% wrong pixels in Chromium — that proved the encoder was the side lying.
 */
import { writeFileSync } from 'node:fs';
import { encodeGif, quantize, toIndexed } from './lib/gif.mjs';

const WIDTH = 240;
const HEIGHT = 160;
const BANDS = [
  [11, 13, 18],
  [110, 231, 183],
  [251, 191, 36],
  [248, 113, 113],
];

const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const band = Math.min(BANDS.length - 1, Math.floor((y / HEIGHT) * BANDS.length));
    const checker = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
    const [r, g, b] = checker && band === 0 ? [70, 90, 120] : BANDS[band];
    const offset = (y * WIDTH + x) * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = 255;
  }
}

const image = { width: WIDTH, height: HEIGHT, pixels };
const { palette, lookup } = quantize(image, 64);
const gif = encodeGif(
  [{ width: WIDTH, height: HEIGHT, indices: toIndexed(image, lookup), delayMs: 1_000 }],
  palette,
);

const out = process.argv[2] ?? '/tmp/outpost-gif-probe.gif';
writeFileSync(out, gif);
console.log(`wrote ${out} (${(gif.length / 1024).toFixed(1)} kB, ${palette.length} colours)`);
console.log('open it: four flat bands, a checkerboard in the first one, no noise, no skew');

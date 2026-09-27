#!/usr/bin/env node
/**
 * Generates the PWA icon set without pulling an image library in.
 *
 * The design is deliberately trivial (rounded square + a ring, both drawn with
 * plain maths) and encoded straight to PNG with zlib, which keeps the repository
 * free of binary blobs nobody can diff and free of a `sharp`-sized dependency.
 *
 * Usage: `npm run icons`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './lib/png.mjs';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../app/public/icons');
const SIZES = [192, 512];

const BACKGROUND = [18, 21, 29];
const ACCENT = [110, 231, 183];

/** Samples per pixel per axis: cheap supersampling for smooth edges. */
const SUPERSAMPLE = 4;

/** Returns the colour of a point, or `null` for transparent. */
function shade(x, y, size) {
  const center = size / 2;
  const distance = Math.hypot(x - center, y - center);

  // The "outpost signal" ring, kept inside the maskable safe zone (~80%).
  if (distance <= size * 0.34 && distance >= size * 0.225) return ACCENT;

  const padding = size * 0.09;
  const radius = size * 0.22;
  const halfSide = center - padding;
  const cornerX = Math.max(Math.abs(x - center) - (halfSide - radius), 0);
  const cornerY = Math.max(Math.abs(y - center) - (halfSide - radius), 0);

  return Math.hypot(cornerX, cornerY) <= radius ? BACKGROUND : null;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let opaque = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const color = shade(px + (sx + 0.5) / SUPERSAMPLE, py + (sy + 0.5) / SUPERSAMPLE, size);
          if (color === null) continue;
          red += color[0];
          green += color[1];
          blue += color[2];
          opaque += 1;
        }
      }

      if (opaque === 0) continue;

      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(red / opaque);
      pixels[offset + 1] = Math.round(green / opaque);
      pixels[offset + 2] = Math.round(blue / opaque);
      pixels[offset + 3] = Math.round((opaque / samples) * 255);
    }
  }

  return pixels;
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, size, render(size)));
  console.log(`wrote ${file}`);
}

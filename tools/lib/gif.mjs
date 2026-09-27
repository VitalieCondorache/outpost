/**
 * A tiny, dependency-free GIF89a encoder — plus the two helpers it needs.
 *
 * Why this exists: Playwright bundles a minimum ffmpeg build whose only muxer is
 * WebM, and the machines that build this project do not necessarily have ffmpeg
 * installed. Encoding a GIF by hand is a few hundred lines and zero installs,
 * which is the same trade-off `generate-icons.mjs` makes for PNG.
 *
 * Scope: 8-bit RGBA PNG input (what Playwright's screenshot produces), one global
 * colour table, no transparency, infinite loop. Anything else is rejected loudly
 * instead of silently mangled.
 */
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit RGBA, non-interlaced PNG into a flat RGBA buffer. */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file');
  }

  let offset = 8;
  let header = null;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + crc

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (header === null) throw new Error('PNG has no IHDR chunk');
  if (header.bitDepth !== 8 || header.colorType !== 6 || header.interlace !== 0) {
    throw new Error(
      `unsupported PNG: bit depth ${header.bitDepth}, colour type ${header.colorType}, ` +
        `interlace ${header.interlace} (only 8-bit RGBA, non-interlaced, is supported)`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? out[x - 4] : 0;
      const up = previous === null ? 0 : previous[x];
      const upLeft = previous === null || x < 4 ? 0 : previous[x - 4];
      out[x] = (line[x] + unfilter(filter, left, up, upLeft)) & 0xff;
    }
  }

  return { width, height, pixels };
}

function unfilter(filter, left, up, upLeft) {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`unknown PNG filter type ${filter}`);
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}
/** Box-filter downscale — screenshots are captured large, encoded small. */
export function downscale(image, targetWidth, targetHeight) {
  const { width, height, pixels } = image;
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;
  const out = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)));

    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let samples = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        let index = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1) {
          r += pixels[index];
          g += pixels[index + 1];
          b += pixels[index + 2];
          samples += 1;
          index += 4;
        }
      }

      const offset = (y * targetWidth + x) * 4;
      out[offset] = Math.round(r / samples);
      out[offset + 1] = Math.round(g / samples);
      out[offset + 2] = Math.round(b / samples);
      out[offset + 3] = 255;
    }
  }

  return { width: targetWidth, height: targetHeight, pixels: out };
}

/**
 * Median-cut quantisation.
 *
 * A UI screenshot is mostly antialiased gradients around a handful of brand
 * colours, so a fixed web-safe cube would band the text badly. Median cut adapts
 * to the actual palette and stays inside GIF's 256-colour limit.
 */
export function quantize(image, maxColors = 256) {
  const { pixels } = image;
  const histogram = new Map();

  for (let index = 0; index < pixels.length; index += 4 * 3) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    const key = (red << 16) | (green << 8) | blue;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  /** @type {Array<{colors: Array<[number, number, number, number]>}>} */
  let buckets = [{ colors: [...histogram].map(([key, count]) => [key, count]) }];

  while (buckets.length < maxColors) {
    const index = widestBucket(buckets);
    if (index === -1) break;

    const bucket = buckets[index];
    const channel = widestChannel(bucket.colors);
    bucket.colors.sort((a, b) => channelValue(a[0], channel) - channelValue(b[0], channel));

    const total = bucket.colors.reduce((sum, entry) => sum + entry[1], 0);
    let running = 0;
    let split = 1;
    for (let i = 0; i < bucket.colors.length; i += 1) {
      running += bucket.colors[i][1];
      if (running * 2 >= total) {
        split = Math.min(Math.max(i + 1, 1), bucket.colors.length - 1);
        break;
      }
    }

    buckets = [
      ...buckets.slice(0, index),
      { colors: bucket.colors.slice(0, split) },
      { colors: bucket.colors.slice(split) },
      ...buckets.slice(index + 1),
    ];
  }

  const palette = buckets.map((bucket) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (const [key, count] of bucket.colors) {
      r += ((key >> 16) & 0xff) * count;
      g += ((key >> 8) & 0xff) * count;
      b += (key & 0xff) * count;
      total += count;
    }
    return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
  });

  return { palette, lookup: buildLookup(palette) };
}

function widestBucket(buckets) {
  let best = -1;
  let bestRange = 0;

  buckets.forEach((bucket, index) => {
    if (bucket.colors.length < 2) return;
    const range = Math.max(
      spanOf(bucket.colors, 16),
      spanOf(bucket.colors, 8),
      spanOf(bucket.colors, 0),
    );
    if (range > bestRange) {
      bestRange = range;
      best = index;
    }
  });

  return best;
}

function spanOf(colors, shift) {
  let min = 255;
  let max = 0;
  for (const [key] of colors) {
    const value = (key >> shift) & 0xff;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min;
}

function widestChannel(colors) {
  const spans = [spanOf(colors, 16), spanOf(colors, 8), spanOf(colors, 0)];
  return spans.indexOf(Math.max(...spans));
}

function channelValue(key, channel) {
  return (key >> (16 - channel * 8)) & 0xff;
}

/** Nearest-colour lookup with a memo, so every distinct pixel costs one search. */
function buildLookup(palette) {
  const cache = new Map();
  return (red, green, blue) => {
    const key = (red << 16) | (green << 8) | blue;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < palette.length; index += 1) {
      const [pRed, pGreen, pBlue] = palette[index];
      const distance = (red - pRed) ** 2 + (green - pGreen) ** 2 + (blue - pBlue) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }

    cache.set(key, best);
    return best;
  };
}

/** Maps a quantised image to palette indices. */
export function toIndexed(image, lookup) {
  const { pixels, width, height } = image;
  const indices = Buffer.alloc(width * height);

  for (let index = 0; index < indices.length; index += 1) {
    const offset = index * 4;
    indices[index] = lookup(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
  }

  return indices;
}
/**
 * LZW compression, GIF flavour: variable code width from `minCodeSize + 1` up to
 * 12 bits, a Clear code that resets the table, codes packed LSB-first and emitted
 * in sub-blocks of at most 255 bytes.
 */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let dictionary = new Map();
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const resetDictionary = () => {
    dictionary = new Map();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  emit(clearCode);

  let prefix = null;
  for (const index of indices) {
    if (prefix === null) {
      prefix = index;
      continue;
    }

    const key = (prefix << 8) | index;
    const known = dictionary.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }

    emit(prefix);
    dictionary.set(key, nextCode);
    nextCode += 1;

    if (codeSize === 12) {
      // 12 bits is the ceiling and 4095 is the last legal code, so a full table
      // (nextCode === 4096) must be reset before another code is assigned.
      if (nextCode === 1 << 12) {
        emit(clearCode);
        resetDictionary();
      }
    } else if (nextCode - 1 === 1 << codeSize) {
      // The decoder's table is always one code behind this one — it only learns
      // the entry we just added when it reads the *next* code — so its table
      // holds `nextCode - 1` entries right now. Grow the width when *it* runs
      // out of room, not when we do: growing on `nextCode === 1 << codeSize`
      // makes the decoder read the first wider code at the old width, and
      // everything after that is garbage. Verified against an independent
      // decoder in the tests and against Chromium's own.
      codeSize += 1;
    }

    prefix = index;
  }

  if (prefix !== null) emit(prefix);
  emit(endCode);

  if (bitCount > 0) bytes.push(bitBuffer & 0xff);

  // Sub-blocks: length byte, then payload, terminated by a zero-length block.
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += 255) {
    const chunk = bytes.slice(offset, offset + 255);
    blocks.push(Buffer.from([chunk.length, ...chunk]));
  }
  blocks.push(Buffer.from([0]));

  return Buffer.concat([Buffer.from([minCodeSize]), ...blocks]);
}

function globalColorTableSize(palette) {
  let size = 1;
  while (1 << size < palette.length) size += 1;
  return Math.max(2, Math.min(8, size)); // GIF colour tables are 2..256 entries
}

/**
 * Encodes frames into a looping GIF89a.
 *
 * @param {{ width: number, height: number, indices: Buffer, delayMs: number }[]} frames
 * @param {Array<[number, number, number]>} palette
 */
export function encodeGif(frames, palette) {
  const [first] = frames;
  if (first === undefined) throw new Error('no frames to encode');

  const tableSize = globalColorTableSize(palette);
  const tableEntries = 1 << tableSize;

  const header = Buffer.from('GIF89a', 'ascii');
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(first.width, 0);
  screen.writeUInt16LE(first.height, 2);
  screen[4] = 0x80 | ((tableSize - 1) << 4) | (tableSize - 1); // global table, colour resolution
  screen[5] = 0; // background colour index
  screen[6] = 0; // pixel aspect ratio

  const table = Buffer.alloc(tableEntries * 3);
  palette.forEach(([red, green, blue], index) => {
    table[index * 3] = red;
    table[index * 3 + 1] = green;
    table[index * 3 + 2] = blue;
  });

  // NETSCAPE2.0: loop forever.
  const loop = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ]);

  const minCodeSize = Math.max(2, tableSize);
  const chunks = [header, screen, table, loop];

  for (const frame of frames) {
    const control = Buffer.alloc(8);
    control[0] = 0x21;
    control[1] = 0xf9;
    control[2] = 0x04;
    control[3] = 0x04; // disposal method 1 (leave in place), no transparency
    control.writeUInt16LE(Math.max(2, Math.round(frame.delayMs / 10)), 4); // hundredths of a second
    control[6] = 0;
    control[7] = 0;

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(frame.width, 5);
    descriptor.writeUInt16LE(frame.height, 7);
    descriptor[9] = 0; // no local colour table, not interlaced

    chunks.push(control, descriptor, lzwEncode(frame.indices, minCodeSize));
  }

  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

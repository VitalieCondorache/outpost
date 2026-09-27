import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodePng, downscale, encodeGif, quantize, toIndexed } from './gif.mjs';
import { encodePng } from './png.mjs';

function rgba(width, height, pick) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pick(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = a;
    }
  }
  return { width, height, pixels };
}

/** A few flat blocks plus a gradient: the shape a UI screenshot actually has. */
function sampleImage() {
  return rgba(8, 6, (x, y) => {
    if (x < 3) return [11, 13, 18];
    if (y < 3) return [110, 231, 183];
    return [x * 20, y * 30, 90];
  });
}

test('PNG round trip: encode then decode returns the same pixels', () => {
  const image = sampleImage();
  const decoded = decodePng(encodePng(image.width, image.height, image.pixels));

  assert.equal(decoded.width, image.width);
  assert.equal(decoded.height, image.height);
  assert.deepEqual([...decoded.pixels], [...image.pixels]);
});

test('decodePng refuses anything it cannot handle, loudly', () => {
  assert.throws(() => decodePng(Buffer.from('definitely not a png')), /not a PNG/);

  const png = encodePng(2, 2, rgba(2, 2, () => [1, 2, 3]).pixels);
  // IHDR: 8-11 length, 12-15 type, 16-19 width, 20-23 height, 24 bit depth,
  // 25 colour type, 26 compression, 27 filter, 28 interlace.
  const rgb = Buffer.from(png);
  rgb[25] = 2; // colour type 2 = RGB, unsupported on purpose
  assert.throws(() => decodePng(rgb), /unsupported PNG/);

  const interlaced = Buffer.from(png);
  interlaced[28] = 1;
  assert.throws(() => decodePng(interlaced), /unsupported PNG/);
});

test('downscale averages blocks instead of picking a pixel', () => {
  const image = rgba(2, 2, (x, y) => [(x + y) * 40, 0, 0]);
  const scaled = downscale(image, 1, 1);

  // (0 + 40 + 40 + 80) / 4
  assert.deepEqual([...scaled.pixels], [40, 0, 0, 255]);
});

test('quantize stays inside the limit and keeps colours recognisable', () => {
  const image = sampleImage();
  const { palette, lookup } = quantize(image, 8);

  assert.ok(palette.length >= 1 && palette.length <= 8, `palette has ${palette.length} entries`);

  for (const [index, entry] of [...palette].entries()) {
    assert.equal(entry.length, 3);
    for (const channel of entry) assert.ok(channel >= 0 && channel <= 255);
    assert.equal(lookup(entry[0], entry[1], entry[2]), index, 'a palette colour maps to itself');
  }

  const indices = toIndexed(image, lookup);
  assert.equal(indices.length, image.width * image.height);
  assert.ok(Math.max(...indices) < palette.length);
});
/** Counts `0x21 0xf9` (graphic control extension) occurrences. */
function countGraphicControls(gif) {
  let count = 0;
  for (let index = 0; index < gif.length - 1; index += 1) {
    if (gif[index] === 0x21 && gif[index + 1] === 0xf9) count += 1;
  }
  return count;
}

test('encodeGif writes a looping GIF89a with one frame per input', () => {
  const image = sampleImage();
  const { palette, lookup } = quantize(image, 32);
  const indices = toIndexed(image, lookup);

  const gif = encodeGif(
    [
      { width: image.width, height: image.height, indices, delayMs: 500 },
      { width: image.width, height: image.height, indices, delayMs: 1_000 },
    ],
    palette,
  );

  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')), 'has the loop extension');
  assert.equal(gif.at(-1), 0x3b, 'ends with the trailer');
  assert.equal(countGraphicControls(gif), 2);
  assert.equal(gif.readUInt16LE(6), image.width);
  assert.equal(gif.readUInt16LE(8), image.height);
});

test('LZW round trip: an independent decoder recovers the exact indices', () => {
  const image = sampleImage();
  const { palette, lookup } = quantize(image, 64);
  const indices = toIndexed(image, lookup);

  const gif = encodeGif(
    [{ width: image.width, height: image.height, indices, delayMs: 100 }],
    palette,
  );

  assert.deepEqual([...decodeFirstFrame(gif)], [...indices]);
});

/**
 * A deliberately simple GIF reader, used only by the round-trip test above.
 *
 * It is written from the specification rather than derived from the encoder, so a
 * shared misunderstanding of the format cannot make the test pass by accident.
 */
function decodeFirstFrame(gif) {
  const tableSize = 1 << ((gif[10] & 0x07) + 1);
  let offset = 13 + tableSize * 3;

  while (offset < gif.length) {
    const marker = gif[offset];
    if (marker === 0x3b) break; // trailer

    if (marker === 0x21) {
      const label = gif[offset + 1];
      offset += 2;
      if (label === 0xff) offset += 1 + gif[offset]; // application id + auth code
      if (label === 0xf9) offset += 1 + gif[offset]; // graphic control block
      while (gif[offset] !== 0) offset += 1 + gif[offset];
      offset += 1;
      continue;
    }

    if (marker === 0x2c) {
      offset += 1;
      const width = gif.readUInt16LE(offset + 4);
      const height = gif.readUInt16LE(offset + 6);
      const packed = gif[offset + 8];
      offset += 9;
      if ((packed & 0x80) !== 0) offset += 3 * (1 << ((packed & 0x07) + 1)); // local table

      const minCodeSize = gif[offset];
      offset += 1;
      const blocks = [];
      while (gif[offset] !== 0) {
        blocks.push(gif.subarray(offset + 1, offset + 1 + gif[offset]));
        offset += 1 + gif[offset];
      }

      return lzwDecode(Buffer.concat(blocks), minCodeSize, width * height);
    }

    throw new Error(`unexpected block 0x${marker.toString(16)} at offset ${offset}`);
  }

  throw new Error('no image block found');
}

function lzwDecode(data, minCodeSize, expectedLength) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output = [];

  let dictionary = createDictionary(minCodeSize);
  let codeSize = minCodeSize + 1;
  let previous = null;
  let bits = 0;
  let bitCount = 0;
  let offset = 0;

  while (output.length < expectedLength) {
    while (bitCount < codeSize && offset < data.length) {
      bits |= data[offset] << bitCount;
      bitCount += 8;
      offset += 1;
    }
    if (bitCount < codeSize) break;

    const code = bits & ((1 << codeSize) - 1);
    bits >>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      dictionary = createDictionary(minCodeSize);
      codeSize = minCodeSize + 1;
      previous = null;
      continue;
    }
    if (code === endCode) break;

    let entry;
    if (code < dictionary.length) {
      entry = dictionary[code];
    } else if (previous !== null) {
      entry = [...previous, previous[0]];
    } else {
      throw new Error(`invalid LZW code ${code}`);
    }

    output.push(...entry);
    if (previous !== null) {
      dictionary.push([...previous, entry[0]]);
      if (dictionary.length === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    previous = entry;
  }

  return Buffer.from(output);
}

function createDictionary(minCodeSize) {
  const dictionary = [];
  for (let index = 0; index < (1 << minCodeSize) + 2; index += 1) dictionary.push([index]);
  return dictionary;
}

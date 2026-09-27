import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
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

/** Flat blocks plus a gradient: the shape the icons and a screenshot actually have. */
function sampleImage() {
  return rgba(8, 6, (x, y) => {
    if (x < 3) return [11, 13, 18];
    if (y < 3) return [110, 231, 183];
    return [x * 20, y * 30, 90];
  });
}

test('round trip: the encoder output decodes back to the same pixels', () => {
  const image = sampleImage();
  const decoded = decodePng(encodePng(image.width, image.height, image.pixels));

  assert.equal(decoded.width, image.width);
  assert.equal(decoded.height, image.height);
  assert.deepEqual([...decoded.pixels], [...image.pixels]);
});

test('refuses a pixel buffer that is not width * height * 4 bytes', () => {
  assert.throws(() => encodePng(2, 2, Buffer.alloc(15)), /expected 16 bytes of RGBA data, got 15/);
});

test('the decoder rejects what the encoder never writes', () => {
  assert.throws(() => decodePng(Buffer.from('definitely not a png')), /not a PNG/);

  const png = encodePng(2, 2, rgba(2, 2, () => [1, 2, 3]).pixels);
  // IHDR: 16-19 width, 20-23 height, 24 bit depth, 25 colour type, 26 compression,
  // 27 filter, 28 interlace.
  const rgb = Buffer.from(png);
  rgb[25] = 2; // colour type 2 = RGB, which this encoder never produces
  assert.throws(() => decodePng(rgb), /unsupported PNG/);

  const interlaced = Buffer.from(png);
  interlaced[28] = 1;
  assert.throws(() => decodePng(interlaced), /unsupported PNG/);
});

/**
 * A PNG reader written from the specification rather than derived from the
 * encoder, so that a shared misunderstanding of the format cannot make the round
 * trip pass by accident.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG file');

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

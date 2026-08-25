// Minimal PNG decoder — zero dependencies.
//
// Scope is deliberate: AWS terrarium elevation tiles are ALWAYS 8-bit, colour
// type 2 (RGB), non-interlaced. We decode exactly that and throw loudly on
// anything else rather than silently returning garbage heights.
//
// ⚠️ Do not "generalise" this into a full PNG library. If a source ever serves
// a different format, the throw is the signal to handle that case explicitly.

import { inflateSync } from 'node:zlib';

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit RGB non-interlaced PNG. Returns {w, h, rgb:Uint8Array(w*h*3)}. */
export function decodePng(buf) {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error('not a PNG (bad signature)');
  }

  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let p = 8;

  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len; // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    throw new Error(
      `unsupported PNG (bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}); ` +
      `expected 8-bit RGB non-interlaced`
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 3;                 // bytes per pixel for 8-bit RGB
  const stride = w * bpp;
  const out = new Uint8Array(w * h * bpp);

  // Defilter scanline by scanline. `prev` is the already-reconstructed row above.
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= bpp ? row[x - bpp] : 0;          // left
      const b = prev ? prev[x] : 0;                   // up
      const c = prev && x >= bpp ? prev[x - bpp] : 0; // upper-left
      let v;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default: throw new Error(`bad PNG filter ${filter} on row ${y}`);
      }
      row[x] = v & 0xff;
    }
    rp += stride;
  }

  return { w, h, rgb: out };
}

/**
 * Terrarium encoding: elevation in metres = (R * 256 + G + B / 256) - 32768.
 * Returns Float32Array(w*h) in row-major order, north-west origin.
 */
export function terrariumToMetres({ w, h, rgb }) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 3) {
    out[i] = rgb[j] * 256 + rgb[j + 1] + rgb[j + 2] / 256 - 32768;
  }
  return out;
}

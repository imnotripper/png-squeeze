// png-squeeze-01-run-20261127 — lossless PNG re-encoder for 1280x720 screenshots.
//
// Strategy (per instance, chosen from the image itself):
//   1. Decode the stored type-6 input PNG to RGBA.
//   2. Pick the cheapest exact representation:
//        - <= 256 unique RGBA colours  -> palette (type 3) + tRNS when alpha varies
//        - all grey, opaque            -> grey (type 0); grey + alpha -> type 4,
//          or type 0 + tRNS when every transparent pixel shares one grey value
//          that no opaque pixel uses
//        - colour, opaque              -> RGB (type 2)
//        - colour, transparent pixels sharing one RGB value no opaque pixel
//          uses                        -> RGB (type 2) + tRNS
//        - otherwise                   -> RGBA (type 6)
//      Palette entries are ordered by frequency (most common first) so the
//      Sub filter sees small index deltas on the runs that dominate flat art.
//   3. Filter every row with the best of the five PNG filters by the
//      minimum-sum-of-|signed-byte| heuristic, scored per row.
//   4. Deflate the filtered stream at level 9, trying the default and the
//      filtered strategies, and keep the smaller result.
//   5. Write a minimal PNG: signature, IHDR, PLTE/tRNS when needed, one
//      IDAT, IEND. No other chunks, bit depth 8, never interlaced.
//
// Deterministic: no clock, no randomness, no environment reads except the
// input/output directory overrides the harness itself documents. The same
// input always yields byte-identical output. Node 22, no dependencies.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC-32
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ------------------------------------------------------------ PNG decode
// Reads the input PNG (stored type 6 per the rules) into raw RGBA samples.
function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 ||
      bytes[3] !== 71 || bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10) {
    throw new Error('not a PNG');
  }
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const len = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error(`unsupported IHDR (depth ${data[8]}, colour ${data[9]}, interlace ${data[12]})`);
      }
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + len;
  }
  if (colourType !== 6) throw new Error(`unsupported colour type ${colourType}`);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const stream = new Uint8Array(total);
  let off = 0;
  for (const chunk of idat) { stream.set(chunk, off); off += chunk.length; }
  const raw = inflateSync(stream);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  let prev = null;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = raw.subarray(src, src + stride);
    src += stride;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      let pred = 0;
      if (filter === 1) pred = i >= 4 ? rgba[dst + i - 4] : 0;
      else if (filter === 2) pred = prev ? prev[i] : 0;
      else if (filter === 3) {
        const a = i >= 4 ? rgba[dst + i - 4] : 0;
        const b = prev ? prev[i] : 0;
        pred = (a + b) >> 1;
      } else if (filter === 4) {
        const a = i >= 4 ? rgba[dst + i - 4] : 0;
        const b = prev ? prev[i] : 0;
        const c = i >= 4 && prev ? prev[i - 4] : 0;
        pred = paeth(a, b, c);
      } else if (filter !== 0) {
        throw new Error(`bad filter ${filter} on row ${y}`);
      }
      rgba[dst + i] = (row[i] + pred) & 0xff;
    }
    prev = rgba.subarray(dst, dst + stride);
  }
  return { width, height, rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// ------------------------------------------------------- filter + scoring
// Writes `cur` (one row, `bpp` bytes per pixel) filtered by `type` into
// `out`, and returns the minimum-sum cost: the sum of the filtered bytes
// read as signed values, absolute. Smaller cost predicts better deflate.
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  let cost = 0;
  if (type === 0) {
    for (let i = 0; i < n; i++) {
      const v = cur[i];
      out[i] = v;
      cost += v < 128 ? v : 256 - v;
    }
    return cost;
  }
  if (type === 1) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const v = (cur[i] - a) & 0xff;
      out[i] = v;
      cost += v < 128 ? v : 256 - v;
    }
    return cost;
  }
  if (type === 2) {
    if (prev) {
      for (let i = 0; i < n; i++) {
        const v = (cur[i] - prev[i]) & 0xff;
        out[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = cur[i];
        out[i] = v;
        cost += v < 128 ? v : 256 - v;
      }
    }
    return cost;
  }
  if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const v = (cur[i] - ((a + b) >> 1)) & 0xff;
      out[i] = v;
      cost += v < 128 ? v : 256 - v;
    }
    return cost;
  }
  // type 4: Paeth
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = i >= bpp && prev ? prev[i - bpp] : 0;
    const v = (cur[i] - paeth(a, b, c)) & 0xff;
    out[i] = v;
    cost += v < 128 ? v : 256 - v;
  }
  return cost;
}

// log2 table for the entropy heuristic: LOG2C[c] = c * log2(c), 0 at c = 0.
const LOG2C = (() => {
  const t = new Float64Array(65536);
  for (let c = 1; c < t.length; c++) t[c] = c * Math.log2(c);
  return t;
})();

// Filters every row of `samples` (height rows of width*bpp). Modes:
//   'minsum'  — cheapest filter per row by the minimum-sum heuristic;
//   'paeth'   — filter 4 on every row (the house baseline's choice, which
//               deflate sometimes prefers on photographic rows despite a
//               worse min-sum);
//   'entropy' — cheapest filter per row by estimated entropy: the filter
//               whose filtered bytes concentrate most (max sum of
//               count*log2(count) over the row's byte histogram), which
//               tracks what Huffman coding actually pays.
function filterImage(samples, width, height, bpp, mode) {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  const hist = new Uint32Array(256);
  let prev = null;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    if (mode === 'paeth') {
      bestType = 4;
      filterRow(4, cur, prev, bpp, best);
    } else if (mode === 'entropy') {
      let bestScore = -Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial);
        hist.fill(0);
        for (let i = 0; i < stride; i++) hist[trial[i]]++;
        let score = 0;
        for (let v = 0; v < 256; v++) score += LOG2C[hist[v]];
        if (score > bestScore) {
          bestScore = score;
          bestType = t;
          best.set(trial);
        }
      }
    } else {
      let bestCost = Infinity;
      for (let t = 0; t < 5; t++) {
        const cost = filterRow(t, cur, prev, bpp, trial);
        if (cost < bestCost) {
          bestCost = cost;
          bestType = t;
          best.set(trial);
        }
      }
    }
    const at = y * (stride + 1);
    out[at] = bestType;
    out.set(best, at + 1);
    prev = cur;
  }
  return out;
}

// ------------------------------------------------------------- PNG encode
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdr(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function assemblePngFrom(width, height, colourType, palette, trns, deflated) {
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr(width, height, colourType))];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', deflated));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { png.set(p, at); at += p.length; }
  return png;
}

// ------------------------------------------------------- representation
// Chooses the cheapest exact colour type for the RGBA image and returns
// { colourType, bpp, samples, palette?, trns? }.
function chooseRepresentation(width, height, rgba) {
  const pixels = width * height;
  const freq = new Map();
  let allGrey = true;
  let allOpaque = true;
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) allOpaque = false;
    const key = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }

  // Palette path: at most 256 distinct colours, and not a grey image:
  // on grey data palette indices scramble the smooth gradients that the
  // Up/Paeth filters exploit, so grey always takes the grey path below.
  if (freq.size <= 256 && !allGrey) {
    const entries = [...freq.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    const indexOf = new Map();
    const palette = new Uint8Array(entries.length * 3);
    const alphas = new Uint8Array(entries.length);
    entries.forEach(([key,], idx) => {
      indexOf.set(key, idx);
      palette[idx * 3] = key & 0xff;
      palette[idx * 3 + 1] = (key >> 8) & 0xff;
      palette[idx * 3 + 2] = (key >> 16) & 0xff;
      alphas[idx] = (key >>> 24) & 0xff;
    });
    const samples = new Uint8Array(pixels);
    for (let i = 0; i < pixels; i++) {
      const key = (rgba[i * 4] | (rgba[i * 4 + 1] << 8) | (rgba[i * 4 + 2] << 16) | (rgba[i * 4 + 3] << 24)) >>> 0;
      samples[i] = indexOf.get(key);
    }
    let trns = null;
    if (!allOpaque) {
      let last = -1;
      for (let i = 0; i < alphas.length; i++) if (alphas[i] !== 255) last = i;
      trns = alphas.subarray(0, last + 1);
    }
    return { colourType: 3, bpp: 1, samples, palette, trns, kind: 'palette' };
  }

  // Grey path.
  if (allGrey) {
    if (allOpaque) {
      const samples = new Uint8Array(pixels);
      for (let i = 0; i < pixels; i++) samples[i] = rgba[i * 4];
      return { colourType: 0, bpp: 1, samples, kind: 'grey' };
    }
    // One shared transparent grey value that no opaque pixel uses?
    // Only valid when every pixel is fully opaque or fully transparent:
    // a semi-transparent pixel has no representation in type 0 + tRNS.
    let transparentGrey = -1;
    let shared = true;
    let allBinaryAlpha = true;
    const opaqueGreys = new Set();
    for (let i = 0; i < pixels; i++) {
      const g = rgba[i * 4];
      const a = rgba[i * 4 + 3];
      if (a === 0) {
        if (transparentGrey === -1) transparentGrey = g;
        else if (transparentGrey !== g) { shared = false; break; }
      } else if (a === 255) {
        opaqueGreys.add(g);
      } else {
        allBinaryAlpha = false;
        break;
      }
    }
    if (allBinaryAlpha && shared && transparentGrey !== -1 && !opaqueGreys.has(transparentGrey)) {
      const samples = new Uint8Array(pixels);
      for (let i = 0; i < pixels; i++) samples[i] = rgba[i * 4];
      const trns = new Uint8Array(2);
      trns[0] = 0;
      trns[1] = transparentGrey;
      return { colourType: 0, bpp: 1, samples, trns, kind: 'grey+trns' };
    }
    const samples = new Uint8Array(pixels * 2);
    for (let i = 0; i < pixels; i++) {
      samples[i * 2] = rgba[i * 4];
      samples[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return { colourType: 4, bpp: 2, samples, kind: 'grey+alpha' };
  }

  // Colour path.
  if (allOpaque) {
    const samples = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      samples[i * 3] = rgba[i * 4];
      samples[i * 3 + 1] = rgba[i * 4 + 1];
      samples[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { colourType: 2, bpp: 3, samples, kind: 'rgb' };
  }
  // One shared transparent RGB that no opaque pixel uses? Only valid when
  // every pixel is fully opaque or fully transparent: a semi-transparent
  // pixel has no representation in type 2 + tRNS.
  let tr = -1, tg = -1, tb = -1;
  let shared = true;
  let allBinaryAlpha = true;
  const opaqueRgb = new Set();
  for (let i = 0; i < pixels; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a === 0) {
      if (tr === -1) { tr = r; tg = g; tb = b; }
      else if (tr !== r || tg !== g || tb !== b) { shared = false; break; }
    } else if (a === 255) {
      opaqueRgb.add((r | (g << 8) | (b << 16)) >>> 0);
    } else {
      allBinaryAlpha = false;
      break;
    }
  }
  if (allBinaryAlpha && shared && tr !== -1 && !opaqueRgb.has((tr | (tg << 8) | (tb << 16)) >>> 0)) {
    const samples = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      samples[i * 3] = rgba[i * 4];
      samples[i * 3 + 1] = rgba[i * 4 + 1];
      samples[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const trns = new Uint8Array(6);
    trns[1] = tr;
    trns[3] = tg;
    trns[5] = tb;
    return { colourType: 2, bpp: 3, samples, trns, kind: 'rgb+trns' };
  }
  return { colourType: 6, bpp: 4, samples: rgba, kind: 'rgba' };
}

// ------------------------------------------------------------------ main
function squeezeOne(id) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  const rep = chooseRepresentation(width, height, rgba);
  // Three filter strategies, decided by the real deflated size: per-row
  // minimum-sum, fixed Paeth, and per-row entropy. Each candidate is
  // deflated once (default strategy); the winner's filtered stream gets
  // one more try with the filtered strategy. All deterministic; the wall
  // budget is guarded by the fixed candidate count, never by the clock.
  let strategy = '';
  let bestFiltered = null;
  let bestDeflated = null;
  for (const mode of ['minsum', 'paeth', 'entropy']) {
    const filtered = filterImage(rep.samples, width, height, rep.bpp, mode);
    const deflated = deflateSync(filtered, { level: 9, memLevel: 9, strategy: 0 });
    if (bestDeflated === null || deflated.length < bestDeflated.length) {
      bestFiltered = filtered;
      bestDeflated = deflated;
      strategy = mode;
    }
  }
  const retry = deflateSync(bestFiltered, { level: 9, memLevel: 9, strategy: 1 });
  if (retry.length < bestDeflated.length) bestDeflated = retry;
  const png = assemblePngFrom(width, height, rep.colourType, rep.palette ?? null, rep.trns ?? null, bestDeflated);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
  return { id, kind: rep.kind, colourType: rep.colourType, strategy, bytes: png.length };
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const r = squeezeOne(id);
  console.error(`${r.id}: ${r.kind} (type ${r.colourType}, ${r.strategy}) -> ${r.bytes} bytes`);
}

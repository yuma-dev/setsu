'use strict';
// just enough of an mp4 reader to feed webcodecs: the sample tables of each track, and the bytes
// of the frames asked for. the audio scrub (mp4-audio.js) and the frame engine (frame-engine.js)
// read clips through this instead of a <video> seek or a spawned ffmpeg
const fs = require('fs');

function* boxes(buf, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    let header = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;
    yield { type: buf.toString('latin1', p + 4, p + 8), start: p + header, end: p + size };
    p += size;
  }
}

function child(buf, box, ...path) {
  let cur = box;
  for (const type of path) {
    let found = null;
    for (const b of boxes(buf, cur.start, cur.end)) {
      if (b.type === type) { found = b; break; }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

async function readMoov(fh, fileSize) {
  const head = Buffer.alloc(16);
  let pos = 0;
  while (pos + 8 <= fileSize) {
    await fh.read(head, 0, 16, pos);
    let size = head.readUInt32BE(0);
    let header = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < header) return null;
    if (head.toString('latin1', 4, 8) === 'moov') {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, pos);
      return { buf, box: { start: header, end: size } };
    }
    pos += size;
  }
  return null;
}

// mpeg-4 descriptor: tag, then a length in up to four 7-bit groups
function descriptor(buf, p) {
  const tag = buf[p++];
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const b = buf[p++];
    len = (len << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag, start: p, end: p + len };
}

/** AudioSpecificConfig out of an esds box, null for anything but mpeg-4 audio */
function audioSpecificConfig(buf, esds) {
  const es = descriptor(buf, esds.start + 4);
  if (es.tag !== 0x03) return null;
  let p = es.start + 2;
  const flags = buf[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + buf[p];
  if (flags & 0x20) p += 2;
  const dc = descriptor(buf, p);
  // 0x40 is mpeg-4 audio; mp3 and the old mpeg-2 aac ids go to ffmpeg
  if (dc.tag !== 0x04 || buf[dc.start] !== 0x40) return null;
  const dsi = descriptor(buf, dc.start + 13);
  if (dsi.tag !== 0x05 || dsi.end > dc.end) return null;
  return buf.subarray(dsi.start, dsi.end);
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
const dec2 = (n) => String(n).padStart(2, '0');

/** webcodecs codec string and description for a visual sample entry, null for codecs we skip */
function videoCodec(buf, entry) {
  // visual sample entry: 78 bytes, then its boxes
  const inner = { start: entry.start + 78, end: entry.end };
  if (entry.type === 'av01') {
    const c = child(buf, inner, 'av1C');
    if (!c) return null;
    const b1 = buf[c.start + 1];
    const b2 = buf[c.start + 2];
    const depth = b2 & 0x40 ? (b2 & 0x20 ? 12 : 10) : 8;
    return { codec: `av01.${b1 >> 5}.${dec2(b1 & 0x1f)}${b2 & 0x80 ? 'H' : 'M'}.${dec2(depth)}`, description: buf.subarray(c.start, c.end) };
  }
  if (entry.type === 'avc1' || entry.type === 'avc3') {
    const c = child(buf, inner, 'avcC');
    if (!c) return null;
    return { codec: `avc1.${hex2(buf[c.start + 1])}${hex2(buf[c.start + 2])}${hex2(buf[c.start + 3])}`, description: buf.subarray(c.start, c.end) };
  }
  if (entry.type === 'hvc1' || entry.type === 'hev1') {
    const c = child(buf, inner, 'hvcC');
    if (!c) return null;
    const b = buf[c.start + 1];
    let compat = buf.readUInt32BE(c.start + 2);
    let reversed = 0;
    for (let i = 0; i < 32; i++, compat >>>= 1) reversed = (reversed << 1) | (compat & 1);
    const constraints = [];
    for (let i = 0; i < 6; i++) constraints.push(buf[c.start + 6 + i]);
    while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
    const space = ['', 'A', 'B', 'C'][b >> 6];
    const codec = `hvc1.${space}${b & 0x1f}.${(reversed >>> 0).toString(16)}.${b & 0x20 ? 'H' : 'L'}${buf[c.start + 12]}${constraints.map((x) => `.${hex2(x)}`).join('')}`;
    return { codec, description: buf.subarray(c.start, c.end) };
  }
  return null;
}

function parseTrack(buf, trak, movieTimescale) {
  const hdlr = child(buf, trak, 'mdia', 'hdlr');
  const handler = hdlr && buf.toString('latin1', hdlr.start + 8, hdlr.start + 12);
  if (handler !== 'soun' && handler !== 'vide') return null;
  const mdhd = child(buf, trak, 'mdia', 'mdhd');
  const stbl = child(buf, trak, 'mdia', 'minf', 'stbl');
  const stsd = stbl && child(buf, stbl, 'stsd');
  if (!mdhd || !stsd) return null;
  const timescale = buf[mdhd.start] === 1 ? buf.readUInt32BE(mdhd.start + 20) : buf.readUInt32BE(mdhd.start + 12);
  const entry = boxes(buf, stsd.start + 8, stsd.end).next().value;
  if (!entry) return null;

  let info;
  if (handler === 'vide') {
    const vc = videoCodec(buf, entry);
    if (!vc) return null;
    info = { kind: 'video', ...vc, width: buf.readUInt16BE(entry.start + 24), height: buf.readUInt16BE(entry.start + 26) };
  } else if (entry.type === 'Opus') {
    // opus always decodes at 48 kHz, family 0 needs no description
    info = { kind: 'audio', codec: 'opus', description: null, channels: buf.readUInt16BE(entry.start + 16), sampleRate: 48000 };
  } else if (entry.type === 'mp4a') {
    // sound sample entry: 28 bytes, quicktime v1 adds 16 and v2 adds 36
    const qtVersion = buf.readUInt16BE(entry.start + 8);
    const extra = qtVersion === 1 ? 16 : qtVersion === 2 ? 36 : 0;
    const esds = child(buf, { start: entry.start + 28 + extra, end: entry.end }, 'esds');
    const asc = esds && audioSpecificConfig(buf, esds);
    if (!asc || asc.length < 2) return null;
    let aot = asc[0] >> 3;
    if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
    info = { kind: 'audio', codec: `mp4a.40.${aot}`, description: asc, channels: buf.readUInt16BE(entry.start + 16), sampleRate: buf.readUInt32BE(entry.start + 24) >>> 16 };
  } else {
    return null;
  }

  const stsz = child(buf, stbl, 'stsz');
  const stsc = child(buf, stbl, 'stsc');
  const stts = child(buf, stbl, 'stts');
  const stco = child(buf, stbl, 'stco');
  const co64 = stco ? null : child(buf, stbl, 'co64');
  if (!stsz || !stsc || !stts || !(stco || co64)) return null;

  const fixedSize = buf.readUInt32BE(stsz.start + 4);
  const count = buf.readUInt32BE(stsz.start + 8);
  const sizeOf = (i) => (fixedSize || buf.readUInt32BE(stsz.start + 12 + i * 4));
  const chunkCount = buf.readUInt32BE((stco || co64).start + 4);
  const chunkOffset = (i) => (stco ? buf.readUInt32BE(stco.start + 8 + i * 4) : Number(buf.readBigUInt64BE(co64.start + 8 + i * 8)));

  // where each frame sits in the file and how big it is, in decode order
  const sizes = new Uint32Array(count);
  const offsets = new Float64Array(count);
  const runs = buf.readUInt32BE(stsc.start + 4);
  let sample = 0;
  for (let r = 0; r < runs && sample < count; r++) {
    const at = stsc.start + 8 + r * 12;
    const first = buf.readUInt32BE(at) - 1;
    const perChunk = buf.readUInt32BE(at + 4);
    const last = r + 1 < runs ? buf.readUInt32BE(at + 12) - 1 : chunkCount;
    for (let c = first; c < last && sample < count; c++) {
      let p = chunkOffset(c);
      for (let k = 0; k < perChunk && sample < count; k++, sample++) {
        sizes[sample] = sizeOf(sample);
        offsets[sample] = p;
        p += sizes[sample];
      }
    }
  }
  const pts = new Float64Array(count);
  let t = 0;
  let s = 0;
  const sttsRuns = buf.readUInt32BE(stts.start + 4);
  for (let r = 0; r < sttsRuns; r++) {
    const n = buf.readUInt32BE(stts.start + 8 + r * 8);
    const delta = buf.readUInt32BE(stts.start + 12 + r * 8);
    for (let k = 0; k < n && s < count; k++, s++, t += delta) pts[s] = t;
  }
  // b-frames: presentation = decode time + the ctts offset (signed in version 1)
  const ctts = child(buf, stbl, 'ctts');
  if (ctts) {
    const signed = buf[ctts.start] === 1;
    const n = buf.readUInt32BE(ctts.start + 4);
    s = 0;
    for (let r = 0; r < n && s < count; r++) {
      const k = buf.readUInt32BE(ctts.start + 8 + r * 8);
      const off = signed ? buf.readInt32BE(ctts.start + 12 + r * 8) : buf.readUInt32BE(ctts.start + 12 + r * 8);
      for (let i = 0; i < k && s < count; i++, s++) pts[s] += off;
    }
  }

  // edit list: leading empty edits delay the track, the first real one skips encoder priming
  let delaySec = 0;
  let skipTicks = 0;
  const elst = child(buf, trak, 'edts', 'elst');
  if (elst) {
    const v1 = buf[elst.start] === 1;
    const n = buf.readUInt32BE(elst.start + 4);
    let p = elst.start + 8;
    for (let i = 0; i < n; i++) {
      const dur = v1 ? Number(buf.readBigUInt64BE(p)) : buf.readUInt32BE(p);
      const mediaTime = v1 ? Number(buf.readBigInt64BE(p + 8)) : buf.readInt32BE(p + 4);
      p += v1 ? 20 : 12;
      if (mediaTime === -1) {
        delaySec += dur / movieTimescale;
      } else {
        skipTicks = mediaTime;
        break;
      }
    }
  }
  // presentation time of each frame in seconds, still in decode order
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = delaySec + (pts[i] - skipTicks) / timescale;
  const step = count > 1 ? (times[count - 1] - times[0]) / (count - 1) : 0;
  const track = { ...info, sizes, offsets, times, count, end: count > 0 ? Math.max(...times.subarray(Math.max(0, count - 8))) + step : 0 };

  if (info.kind === 'video') {
    // sync samples; no stss means every frame is one
    const keys = new Uint8Array(count);
    const stss = child(buf, stbl, 'stss');
    if (stss) {
      const n = buf.readUInt32BE(stss.start + 4);
      for (let i = 0; i < n; i++) {
        const k = buf.readUInt32BE(stss.start + 8 + i * 4) - 1;
        if (k >= 0 && k < count) keys[k] = 1;
      }
    } else {
      keys.fill(1);
    }
    const order = Uint32Array.from({ length: count }, (_, i) => i).sort((a, b) => times[a] - times[b]);
    track.keys = keys;
    // presentation index -> decode index, and the sorted times to search
    track.order = order;
    track.presTimes = Float64Array.from(order, (i) => times[i]);
  }
  return track;
}

/** every track of the file in stream order (ffprobe's index), parsed or null */
async function readTracks(fh) {
  const { size } = await fh.stat();
  const moov = await readMoov(fh, size);
  if (!moov) throw new Error('no moov box');
  const { buf, box } = moov;
  const mvhd = child(buf, box, 'mvhd');
  const movieTimescale = buf[mvhd.start] === 1 ? buf.readUInt32BE(mvhd.start + 20) : buf.readUInt32BE(mvhd.start + 12);
  const tracks = [];
  for (const b of boxes(buf, box.start, box.end)) {
    if (b.type === 'trak') tracks.push(parseTrack(buf, b, movieTimescale));
  }
  return tracks;
}

/** first frame (decode order) presented at or after sec; for tracks without reordering */
function frameAt(track, sec) {
  let lo = 0;
  let hi = track.count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track.times[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * frames [from, to) (decode order) of several tracks with as few reads as possible. a recorder
 * interleaves one frame per chunk per track, but each step's tracks sit back to back, so
 * neighbours share a read
 * @param {{ track: any, from: number, to: number }[]} ranges
 * @returns {Promise<{ data: Buffer, at: Uint32Array }[]>} per range, frame from+i at at[i]
 */
async function readFrames(fh, ranges) {
  const all = [];
  ranges.forEach(({ track, from, to }, r) => {
    for (let s = from; s < to; s++) all.push({ r, s, offset: track.offsets[s], size: track.sizes[s] });
  });
  all.sort((x, y) => x.offset - y.offset);
  const spans = [];
  for (const f of all) {
    const last = spans[spans.length - 1];
    // a small gap is cheaper to read through than to split on
    if (last && f.offset - last.end <= 4096) {
      last.end = Math.max(last.end, f.offset + f.size);
      last.frames.push(f);
    } else {
      spans.push({ start: f.offset, end: f.offset + f.size, frames: [f] });
    }
  }
  const data = Buffer.alloc(spans.reduce((n, sp) => n + sp.end - sp.start, 0));
  const at = ranges.map(({ from, to }) => new Uint32Array(Math.max(0, to - from)));
  let pos = 0;
  const jobs = spans.map((sp) => {
    const into = pos;
    pos += sp.end - sp.start;
    for (const f of sp.frames) at[f.r][f.s - ranges[f.r].from] = into + (f.offset - sp.start);
    return () => fh.read(data, into, sp.end - sp.start, sp.start);
  });
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
  return at.map((a) => ({ data, at: a }));
}

const open = (file) => fs.promises.open(file, 'r');

module.exports = { open, readTracks, readFrames, frameAt };

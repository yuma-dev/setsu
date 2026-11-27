'use strict';
// the trim scrub's audio without ffmpeg: pulls only the audio frames of the wanted tracks out of the
// clip (mp4.js, ~1.4 MB a minute a track, the video is never touched) and decodes them with
// webcodecs. ffmpeg took ~0.45 s for one track and ~1 s for a 4-track mix; this has the 2 s under
// the handle in ~30 ms and the whole minute in ~0.25 s (one track) to ~0.75 s (4)
const mp4 = require('./mp4');
const { frameAt, readFrames } = mp4;

// decoded ahead of a segment and thrown away: aac needs a frame for its overlap, opus wants 80 ms
// of pre-roll and its frames can be 20 ms or less
const PREROLL_S = 0.2;
// the one under the handle decodes alone, so it isn't queued behind its neighbours
const SEGMENT_S = 2;
// decoders at work at once; chromium spends ~110 us a frame, parallel ones overlap well
const DECODERS = 4;

/** frames [from, to) of one track through a fresh webcodecs decoder; onBlock(timeSec, channels, n) */
async function decodeFrames(track, from, to, frames, onBlock) {
  let failed = null;
  const scratch = [];
  const decoder = new AudioDecoder({
    output: (audio) => {
      try {
        const n = audio.numberOfFrames;
        for (let c = 0; c < audio.numberOfChannels; c++) {
          if (!scratch[c] || scratch[c].length < n) scratch[c] = new Float32Array(n);
          audio.copyTo(scratch[c].subarray(0, n), { planeIndex: c, format: 'f32-planar' });
        }
        onBlock(audio.timestamp / 1e6 - shift, scratch, audio.numberOfChannels, n);
      } finally {
        audio.close();
      }
    },
    error: (e) => { failed = e; },
  });
  // the priming frames sit before 0. fed those negative timestamps, chromium's opus output came
  // out exactly the 312 pre-skip samples late, so the decoder only ever sees times from 0 up
  const shift = Math.max(0, -track.times[0]);
  decoder.configure(track.config);
  for (let s = from; s < to && !failed; s++) {
    const p = frames.at[s - from];
    decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((track.times[s] + shift) * 1e6), data: frames.data.subarray(p, p + track.sizes[s]) }));
  }
  try {
    await decoder.flush();
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (failed) throw failed;
}

/**
 * decodes the mix the player is playing (the given streams at their volumes, or the first audio
 * track when mix is null) to mono s16 at half the source rate, in 2 s segments nearest `around`
 * first so scrubbing can start long before the whole clip is done
 * @param {string} file
 * @param {{ streamIndex: number, volume: number }[] | null} mix
 * @param {{ around: number, onStart: (info: { rate: number, length: number }) => void, onFill: (offset: number, pcm: Int16Array) => void, cancelled?: () => boolean }} sink
 * @returns {Promise<boolean>} false when nothing is audible
 */
async function streamMix(file, mix, { around, onStart, onFill, cancelled = () => false }) {
  if (typeof AudioDecoder === 'undefined') throw new Error('no webcodecs');
  const fh = await mp4.open(file);
  try {
    const tracks = await mp4.readTracks(fh);
    const wanted = Array.isArray(mix)
      ? mix.map((m) => ({ track: tracks[m.streamIndex], volume: Math.max(0, Number(m.volume) || 0) }))
      : [{ track: tracks.find((t) => t && t.kind === 'audio'), volume: 1 }];
    if (wanted.length === 0) return false;
    if (wanted.some((w) => !w.track || w.track.kind !== 'audio' || w.track.count === 0)) throw new Error('track not parsed');
    const srcRate = wanted[0].track.sampleRate;
    if (wanted.some((w) => w.track.sampleRate !== srcRate)) throw new Error('mixed sample rates');
    for (const w of wanted) {
      const config = { codec: w.track.codec, sampleRate: w.track.sampleRate, numberOfChannels: w.track.channels };
      if (w.track.description) config.description = w.track.description;
      if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error(`webcodecs can't decode ${w.track.codec}`);
      w.track.config = config;
    }
    // half rate is plenty for scrubbing and halves the memory; pairs are averaged on the way in
    const factor = srcRate >= 44100 ? 2 : 1;
    const rate = srcRate / factor;
    const seconds = Math.max(...wanted.map((w) => w.track.end));
    const out = new Float32Array(Math.ceil(seconds * rate));
    onStart({ rate, length: out.length });

    const segments = [];
    for (let a = 0; a < seconds; a += SEGMENT_S) segments.push({ a, b: Math.min(seconds, a + SEGMENT_S) });
    const at = Number.isFinite(around) ? around : 0;
    segments.sort((x, y) => Math.abs((x.a + x.b) / 2 - at) - Math.abs((y.a + y.b) / 2 - at));

    const runSegment = async ({ a, b }) => {
      const ranges = wanted.map(({ track }) => ({ track, from: frameAt(track, a - PREROLL_S), to: frameAt(track, b) }));
      const frames = await readFrames(fh, ranges);
      // this segment owns source samples [lo, hi); pre-roll output lands before lo and is dropped
      const lo = Math.round(a * srcRate);
      const hi = Math.round(b * srcRate);
      await Promise.all(wanted.map(({ track, volume }, i) => {
        const k = volume / track.channels / factor;
        return decodeFrames(track, ranges[i].from, ranges[i].to, frames[i], (t, chans, nch, n) => {
          const first = Math.round(t * srcRate);
          const i0 = Math.max(0, lo - first);
          const i1 = Math.min(n, hi - first);
          for (let s = i0; s < i1; s++) {
            let v = 0;
            for (let c = 0; c < nch; c++) v += chans[c][s];
            const j = Math.floor((first + s) / factor);
            if (j < out.length) out[j] += v * k;
          }
        });
      }));
      const j0 = Math.floor(lo / factor);
      const j1 = Math.min(out.length, Math.ceil(hi / factor));
      const pcm = new Int16Array(Math.max(0, j1 - j0));
      for (let j = 0; j < pcm.length; j++) {
        const v = out[j0 + j] * 32767;
        pcm[j] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      onFill(j0, pcm);
    };

    await runSegment(segments[0]);
    let next = 1;
    await Promise.all(Array.from({ length: DECODERS }, async () => {
      while (next < segments.length && !cancelled()) await runSegment(segments[next++]);
    }));
    return true;
  } finally {
    await fh.close();
  }
}

module.exports = { streamMix };

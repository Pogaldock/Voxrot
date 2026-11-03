// VOXROT vocal DSP
// ------------------------------------------------------------
// detectPitch  : YIN pitch tracking (how fast the wave repeats -> which note)
// tuneRatios   : for every pitch frame, how much to shift to land on the scale
// psola        : moves pitch without changing speed, keeps the voice's character
// processTake  : full chain used by the app (tune, octave layer, chipmunk, crush, stutter)
// Pure functions on Float32Arrays: no Web Audio here, so it runs in node tests too.
// ------------------------------------------------------------

// ---------- pitch detection (YIN) ----------
// Works on a downsampled copy (~16 kHz) to stay fast on a phone.
export function detectPitch(x, sr) {
  const D = Math.max(1, Math.round(sr / 16000));
  const rs = sr / D;
  const n = Math.floor(x.length / D);
  const ds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < D; j++) s += x[i * D + j];
    ds[i] = s / D;
  }
  const W = 512;
  const Hd = 128;
  const tauMin = Math.floor(rs / 1100);
  const tauMax = Math.floor(rs / 65);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ds[i]));
  const gate = Math.max(0.004, peak * 0.04);

  const frames = Math.max(0, Math.floor((n - W - tauMax) / Hd) + 1);
  const f0 = new Float32Array(frames);
  const voiced = new Uint8Array(frames);
  const d = new Float32Array(tauMax + 1);
  for (let k = 0; k < frames; k++) {
    const i0 = k * Hd;
    let e = 0;
    for (let j = 0; j < W; j++) e += ds[i0 + j] * ds[i0 + j];
    const rms = Math.sqrt(e / W);
    if (rms < gate) continue;
    d[0] = 1;
    let run = 0;
    let best = -1;
    let bestVal = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const df = ds[i0 + j] - ds[i0 + j + tau];
        s += df * df;
      }
      run += s;
      d[tau] = run > 0 ? (s * tau) / run : 1;
    }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < 0.15) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        bestVal = d[tau];
        break;
      }
    }
    if (best < 0) {
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < bestVal) { bestVal = d[tau]; best = tau; }
    }
    if (best < 0 || bestVal > 0.3) continue;
    // parabolic interpolation for sub-sample accuracy
    let t = best;
    if (best > 1 && best < tauMax) {
      const a = d[best - 1], b = d[best], c = d[best + 1];
      const den = a - 2 * b + c;
      if (den !== 0) t = best + (0.5 * (a - c)) / den;
    }
    f0[k] = rs / t;
    voiced[k] = 1;
  }
  // median-of-5 cleanup + octave-jump repair
  const clean = new Float32Array(frames);
  for (let k = 0; k < frames; k++) {
    if (!voiced[k]) continue;
    const win = [];
    for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < frames && voiced[j]) win.push(f0[j]);
    win.sort((a, b) => a - b);
    const med = win[win.length >> 1];
    let v = f0[k];
    const r = v / med;
    if (r > 1.8 && r < 2.2) v /= 2;
    else if (r > 0.45 && r < 0.55) v *= 2;
    clean[k] = v;
  }
  // fill single-frame dropouts so a held note doesn't stutter
  for (let k = 1; k < frames - 1; k++) {
    if (!voiced[k] && voiced[k - 1] && voiced[k + 1]) {
      voiced[k] = 1;
      clean[k] = (clean[k - 1] + clean[k + 1]) / 2;
    }
  }
  return {
    sr,
    hop: Hd * D, // samples (original rate) between frames
    offset: (W / 2) * D, // sample position of frame 0's center
    f0: clean,
    voiced
  };
}

export function frameAt(track, n) {
  const k = Math.round((n - track.offset) / track.hop);
  return Math.min(track.f0.length - 1, Math.max(0, k));
}

const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);

// nearest MIDI note whose pitch class is in the scale
export function snapToScale(midi, scalePcs) {
  const r = Math.round(midi);
  let best = r;
  let bestDist = Infinity;
  for (let c = r - 2; c <= r + 2; c++) {
    if (!scalePcs.includes(((c % 12) + 12) % 12)) continue;
    const dist = Math.abs(c - midi);
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

// Per-frame pitch ratio that lands each frame on the scale.
// speed: "hard" (instant robot jump), "med", "soft", "off"
export function tuneRatios(track, scalePcs, speed) {
  const tau = { hard: 0, med: 0.04, soft: 0.12, off: -1 }[speed] ?? 0;
  const ratios = new Float32Array(track.f0.length).fill(1);
  if (tau < 0) return ratios;
  const hopSec = track.hop / track.sr;
  const alpha = tau === 0 ? 1 : 1 - Math.exp(-hopSec / tau);
  let cur = null;
  for (let k = 0; k < track.f0.length; k++) {
    if (!track.voiced[k]) { cur = null; continue; }
    const m = hzToMidi(track.f0[k]);
    const target = snapToScale(m, scalePcs);
    cur = cur === null ? target : cur + (target - cur) * alpha;
    ratios[k] = Math.pow(2, (cur - m) / 12);
  }
  return ratios;
}

// ---------- PSOLA ----------
// x: input, track: from detectPitch, ratios: per-frame pitch ratio,
// stretch: output length factor (used by formantShift; 1 = normal).
export function psola(x, sr, track, ratios, stretch = 1, pitchMul = 1) {
  const len = x.length;
  // 1. analysis marks: one per vibration, snapped to the wave's peaks
  const marks = [];
  let n = 0;
  const uvP = Math.round(sr / 160);
  while (n < len) {
    const k = frameAt(track, n);
    if (track.voiced[k] && track.f0[k] > 0) {
      const P = sr / track.f0[k];
      const lo = Math.max(0, Math.round(n - P * 0.3));
      const hi = Math.min(len - 1, Math.round(n + P * 0.3));
      let arg = Math.round(n);
      let mx = -Infinity;
      for (let i = lo; i <= hi; i++) if (x[i] > mx) { mx = x[i]; arg = i; }
      const prev = marks.length ? marks[marks.length - 1].n : -Infinity;
      const pos = arg > prev + P * 0.5 ? arg : Math.round(n);
      marks.push({ n: pos, P: Math.round(P), v: true, k });
      n = pos + P;
    } else {
      marks.push({ n: Math.round(n), P: uvP, v: false, k });
      n += uvP;
    }
  }
  // 2. synthesis: lay grains down at the new spacing
  const outLen = Math.round(len * stretch);
  const y = new Float32Array(outLen);
  const w = new Float32Array(outLen);
  let tOut = 0;
  let mi = 0;
  const cosCache = new Map();
  const win = (P) => {
    let c = cosCache.get(P);
    if (!c) {
      c = new Float32Array(2 * P + 1);
      for (let j = -P; j <= P; j++) c[j + P] = 0.5 * (1 + Math.cos((Math.PI * j) / (P + 1)));
      cosCache.set(P, c);
    }
    return c;
  };
  while (tOut < outLen && marks.length) {
    const tIn = tOut / stretch;
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1].n - tIn) <= Math.abs(marks[mi].n - tIn)) mi++;
    const m = marks[mi];
    const P = m.P;
    const wv = win(P);
    const center = Math.round(tOut);
    for (let j = -P; j <= P; j++) {
      const s = m.n + j;
      const d = center + j;
      if (s < 0 || s >= len || d < 0 || d >= outLen) continue;
      y[d] += x[s] * wv[j + P];
      w[d] += wv[j + P];
    }
    const r = m.v ? (ratios[m.k] * pitchMul) / stretch : 1;
    tOut += Math.max(8, P / r);
  }
  for (let i = 0; i < outLen; i++) if (w[i] > 1) y[i] /= w[i];
  return y;
}

// linear-interpolation resample to `outLen` samples
export function resampleTo(y, outLen) {
  const out = new Float32Array(outLen);
  const k = y.length / outLen;
  for (let i = 0; i < outLen; i++) {
    const p = i * k;
    const a = Math.floor(p);
    const f = p - a;
    out[i] = (y[a] || 0) * (1 - f) + (y[a + 1] || 0) * f;
  }
  return out;
}

// Pitch AND formants up by `formant` (chipmunk), pitch landing on ratios*pitchMul.
// Trick: PSOLA-stretch longer by `formant` at pitch/formant, then play it back faster.
export function formantShift(x, sr, track, ratios, pitchMul, formant) {
  const long = psola(x, sr, track, ratios, formant, pitchMul);
  return resampleTo(long, x.length);
}

// ---------- effects ----------
export function crush(x, amount = 1) {
  const out = new Float32Array(x.length);
  const levels = 24;
  const hold = 3;
  const drive = 3.5;
  const t = Math.tanh(drive);
  let held = 0;
  for (let i = 0; i < x.length; i++) {
    if (i % hold === 0) held = Math.round(x[i] * levels) / levels;
    const dist = Math.tanh(x[i] * drive) / t;
    out[i] = x[i] * (1 - amount) + amount * (0.5 * held + 0.5 * dist);
  }
  return out;
}

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Repeats short slices on the 16th-note grid (glitch stutter).
// gridStart: sample where bar 1 beat 1 sits; stepLen: samples per 16th.
export function stutter(x, gridStart, stepLen, steps, seed) {
  const out = x.slice();
  const rng = makeRng(seed);
  const fade = 48;
  for (let s = 0; s < steps; s++) {
    const inBar = s % 16;
    const lastBeat = inBar >= 12;
    const p = lastBeat ? (s >= steps - 4 ? 0.6 : 0.25) : 0.06;
    if (rng() >= p) continue;
    const slice = Math.round(stepLen / (rng() < 0.5 ? 2 : 4));
    const reps = Math.round((stepLen * 2) / slice);
    const src = Math.round(gridStart + s * stepLen);
    if (src < 0 || src + slice >= x.length) continue;
    for (let r = 1; r < reps; r++) {
      const dst = src + r * slice;
      for (let i = 0; i < slice; i++) {
        const d = dst + i;
        if (d >= out.length) break;
        let g = 1;
        if (i < fade) g = i / fade;
        else if (i > slice - fade) g = (slice - i) / fade;
        out[d] = x[src + i] * g;
      }
    }
    s += 1;
  }
  return out;
}

export function normalize(x, peakTarget = 0.9) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  if (pk < 1e-6) return x;
  const g = peakTarget / pk;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

// ---------- full take chain ----------
// take: { raw: Float32Array, sr, track? }
// opts: { scalePcs, tune, oct, chip, wide, crush, stutter, gridStart, stepLen, steps, seed }
// Returns [left, right].
// Producer conventions used here:
//   chipmunk = formants up (lead ~+3.5 semitones, octave layer ~+6.5), pitch kept on the note
//   octave layer = same tuned line one octave up, under the lead
//   wide = two doubles detuned +10 / -10 cents, panned hard left / right
const CENTS10 = Math.pow(2, 10 / 1200);
export function processTake(take, opts) {
  const { raw, sr } = take;
  if (!take.track) take.track = detectPitch(raw, sr);
  const tr = take.track;
  const ratios = tuneRatios(tr, opts.scalePcs, opts.tune);
  const shift = (mul, formant) => (opts.chip ? formantShift(raw, sr, tr, ratios, mul, formant) : psola(raw, sr, tr, ratios, 1, mul));
  const main = shift(1, 1.22);
  let L = main.slice();
  let R = main.slice();
  if (opts.oct) {
    const up = shift(2, 1.45);
    for (let i = 0; i < L.length; i++) {
      L[i] = L[i] * 0.85 + up[i] * 0.55;
      R[i] = R[i] * 0.85 + up[i] * 0.55;
    }
  }
  if (opts.wide) {
    const dl = shift(CENTS10, 1.22);
    const dr = shift(1 / CENTS10, 1.22);
    for (let i = 0; i < L.length; i++) {
      L[i] = L[i] * 0.8 + dl[i] * 0.5;
      R[i] = R[i] * 0.8 + dr[i] * 0.5;
    }
  }
  if (opts.crush) {
    L = crush(L, 0.6);
    R = crush(R, 0.6);
  }
  if (opts.stutter) {
    L = stutter(L, opts.gridStart, opts.stepLen, opts.steps, opts.seed);
    R = stutter(R, opts.gridStart, opts.stepLen, opts.steps, opts.seed);
  }
  let pk = 0;
  for (let i = 0; i < L.length; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  if (pk > 1e-6) {
    const g = 0.9 / pk;
    for (let i = 0; i < L.length; i++) {
      L[i] *= g;
      R[i] *= g;
    }
  }
  return [L, R];
}

// Finds click onsets in a recording (for latency calibration).
// Returns onset sample indices, at most one per `minGap` samples.
export function findOnsets(x, sr, minGap) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i]));
  const thr = pk * 0.35;
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > thr && i - last > minGap) {
      out.push(i);
      last = i;
    }
  }
  return out;
}

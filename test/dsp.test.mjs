// Synthetic "voice": glottal-ish pulse train through two formant resonators,
// sung slightly flat with vibrato. Then autotune it and measure the result.
import { detectPitch, tuneRatios, psola, formantShift, processTake, snapToScale } from "../js/dsp.js";
import { scalePitchClasses } from "../js/vibes.js";

const sr = 48000;
function voice(f0fn, secs) {
  const n = Math.floor(sr * secs);
  const src = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += f0fn(i / sr) / sr;
    if (ph >= 1) { ph -= 1; src[i] = 1; }
  }
  // two resonators (formants ~700 Hz and ~1200 Hz)
  const out = new Float32Array(n);
  for (const [fc, bw, g] of [[700, 110, 1], [1200, 120, 0.6]]) {
    const r = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fc / sr;
    const a1 = 2 * r * Math.cos(th), a2 = -r * r;
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) { const y = src[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; out[i] += g * y * 0.05; }
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pitchOf = (x) => { const t = detectPitch(x, sr); const v = []; for (let k = 5; k < t.f0.length - 5; k++) if (t.voiced[k]) v.push(t.f0[k]); return { med: median(v), voicedFrac: v.length / t.f0.length }; };
const cents = (a, b) => 1200 * Math.log2(a / b);

let fails = 0;
const check = (name, ok, info) => { console.log((ok ? "PASS " : "FAIL ") + name + "  " + info); if (!ok) fails++; };

// singer aims for A3 (220) but is 40 cents flat with 15-cent vibrato
const flat = 220 * Math.pow(2, -40 / 1200);
const x = voice((t) => flat * Math.pow(2, (15 * Math.sin(2 * Math.PI * 5.5 * t)) / 1200), 2);
const scale = scalePitchClasses(6, "minor"); // F# minor contains A
check("snap A-flat to A", snapToScale(56.6, scale) === 57, "");

const inP = pitchOf(x);
check("detects input pitch", Math.abs(cents(inP.med, flat)) < 15, `in=${inP.med.toFixed(1)}Hz voiced=${(inP.voicedFrac*100)|0}%`);

const tr = detectPitch(x, sr);
const t0 = performance.now();
const tuned = psola(x, sr, tr, tuneRatios(tr, scale, "hard"), 1, 1);
const ms = performance.now() - t0;
const out = pitchOf(tuned);
check("hard tune lands on A3", Math.abs(cents(out.med, 220)) < 12, `out=${out.med.toFixed(1)}Hz (${cents(out.med,220).toFixed(1)} cents) in ${ms.toFixed(0)}ms`);
check("same length", tuned.length === x.length, "");

// note not in scale: G (196) in F# minor should go to G# (207.65) or F# (185)
const g = voice(() => 196 * Math.pow(2, 30/1200), 1.5);
const gt = detectPitch(g, sr);
const gOut = pitchOf(psola(g, sr, gt, tuneRatios(gt, scale, "hard"), 1, 1));
check("off-scale note snaps to scale", Math.abs(cents(gOut.med, 207.65)) < 15 || Math.abs(cents(gOut.med, 185)) < 15, `out=${gOut.med.toFixed(1)}Hz`);

const up = pitchOf(psola(x, sr, tr, tuneRatios(tr, scale, "hard"), 1, 2));
check("octave layer at A4", Math.abs(cents(up.med, 440)) < 15, `out=${up.med.toFixed(1)}Hz`);

const chip = formantShift(x, sr, tr, tuneRatios(tr, scale, "hard"), 1, 1.22);
const chipP = pitchOf(chip);
check("chipmunk keeps tuned pitch", Math.abs(cents(chipP.med, 220)) < 20 && chip.length === x.length, `out=${chipP.med.toFixed(1)}Hz`);

// full chain with everything on, 8 s take, timing
const long = voice((t) => flat * Math.pow(2, (15 * Math.sin(2 * Math.PI * 5.5 * t)) / 1200), 8);
const t1 = performance.now();
const full = processTake({ raw: long, sr }, { scalePcs: scale, tune: "hard", oct: true, chip: true, wide: true, crush: true, stutter: true, gridStart: 14400, stepLen: 4500, steps: 64, seed: 7 });
const fullMs = performance.now() - t1;
let pk = 0, nan = 0; for (const ch of full) for (const v of ch) { if (Number.isNaN(v)) nan++; pk = Math.max(pk, Math.abs(v)); }
check("stereo out", full.length === 2 && full[0].length === long.length, "");
check("full chain clean output", nan === 0 && pk > 0.5 && pk <= 0.91, `peak=${pk.toFixed(2)} ${fullMs.toFixed(0)}ms for 8s`);

// wide doubles: left double sits +10 cents, right -10 cents
const tr2 = detectPitch(x, sr);
const r2 = tuneRatios(tr2, scale, "hard");
const dl = pitchOf(psola(x, sr, tr2, r2, 1, Math.pow(2, 10/1200)));
check("double +10 cents", Math.abs(cents(dl.med, 220) - 10) < 6, `${cents(dl.med,220).toFixed(1)} cents`);
// latency calibration onset finder
import("../js/dsp.js").then(()=>{});
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);

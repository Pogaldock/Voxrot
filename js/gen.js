// VOXROT generators, mutation and taste
// ------------------------------------------------------------
// Every part (drums, bass, chords, melody) is a small genome:
//   genes : 4 dials, 0..1, the controls you see on the part screen
//   seed  : fixed random numbers the dials are compared against, so turning a
//           dial up adds hits one at a time instead of reshuffling everything
//   pattern / notes : the result, which you can also edit by hand
//   sound : sound-design genes (SOUND tab), 0..1 each, lockable
//
// Rules the generators follow (from producer and songwriting guides):
//   drums  : kick always on 1; hats from straight 8ths up to 16ths with 32nd rolls
//            placed before backbeats and at half-bar ends
//   bass   : follows the kick (Logic "Follow"), extra hits and octave jumps with BUSY
//   melody : chord tones on strong beats, ~70% stepwise motion, 2-3 rhythms reused
//            across bars, last note resolves to a chord tone
// ------------------------------------------------------------
import { parseNumeral, SCALES } from "./vibes.js";

export const STEPS = 16;
export const PARTS = ["drums", "bass", "chords", "melody"];

export const GENE_NAMES = {
  drums: ["BUSY", "HARD", "SWING", "TONE"],
  bass: ["BUSY", "HARD", "SLIDE", "OCTAVE"],
  chords: ["BUSY", "BRIGHT", "WIDTH", "LENGTH"],
  melody: ["BUSY", "RANGE", "REPEAT", "HIGH"]
};

// SOUND tab genes: [label, default, mutation range lo, hi]
export const SOUND_GENES = {
  drums: [["KICK PITCH", 0.5, 0.2, 0.8], ["KICK LENGTH", 0.5, 0.3, 0.8], ["SNARE SNAP", 0.5, 0.2, 0.9], ["HAT LENGTH", 0.3, 0.1, 0.6], ["DRIVE", 0.6, 0.2, 0.95]],
  bass: [["DIVE", 0.4, 0.2, 0.8], ["LENGTH", 0.8, 0.5, 1], ["DRIVE", 0.7, 0.3, 1], ["SUB", 0.6, 0.3, 0.9], ["TONE", 0.5, 0.2, 0.8]],
  chords: [["DETUNE", 0.5, 0.2, 0.9], ["ATTACK", 0.05, 0, 0.4], ["RELEASE", 0.3, 0.1, 0.7], ["CRUSH", 0.3, 0, 0.6], ["SPACE", 0.3, 0.1, 0.7]],
  melody: [["DETUNE", 0.4, 0.1, 0.8], ["GLIDE", 0.2, 0, 0.6], ["BRIGHT", 0.7, 0.4, 1], ["CRUSH", 0.1, 0, 0.5], ["SPACE", 0.35, 0.1, 0.7]]
};

// ---------- random ----------
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
export const newSeed = () => Math.floor(Math.random() * 2 ** 31) + 1;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const hit = (p, i) => !!p && p[i % 16] === "x";

// Euclidean rhythm: k hits spread as evenly as possible over n steps (Toussaint)
export function euclid(k, n, rot = 0) {
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) out[(i + rot) % n] = Math.floor(((i + 1) * k) / n) - Math.floor((i * k) / n) ? 1 : 0;
  return out;
}

// ---------- drums ----------
// pattern rows: arrays of 16; hat values: 0 off, 1 hit, 2/3/4 = roll of that many hits inside the 16th
export function genDrums(vibe, genes, seed) {
  const r = rng(seed);
  const tables = Array.from({ length: 6 }, () => Array.from({ length: 16 }, () => r()));
  const [busy] = genes;
  const v = vibe.drums;
  const kick = [];
  const clap = [];
  const hat = [];
  const ohat = [];
  for (let i = 0; i < 16; i++) {
    const base = hit(v.kick, i);
    const strong = i % 4 === 0;
    // extra kicks appear with BUSY, preferring off-beat 8ths; base kicks drop out only when BUSY is very low
    let k = base ? (i === 0 || tables[0][i] > 0.35 - busy * 0.8 ? 1 : 0) : (!strong && i % 2 === 0 ? tables[1][i] < busy * 0.32 : tables[1][i] < busy * 0.12) ? 1 : 0;
    if (i === 0) k = 1;
    kick.push(k);
    clap.push(hit(v.clap, i) ? 1 : busy > 0.75 && tables[2][i] < (busy - 0.75) * 0.6 && i % 2 === 1 ? 1 : 0);
    // hats: 8ths always, 16ths fade in with BUSY, rolls above 0.6
    const eighth = i % 2 === 0;
    let h = hit(v.hat, i) ? 1 : 0;
    if (eighth) h = busy > 0.08 ? 1 : h;
    else if (tables[3][i] < (busy - 0.3) * 1.4) h = 1;
    const beforeBack = hit(v.clap, i + 1) || i === 7 || i === 15;
    if (h && busy > 0.6 && beforeBack && tables[4][i] < (busy - 0.6) * 2.2) h = tables[4][i] < 0.15 ? 4 : tables[4][i] < 0.35 ? 3 : 2;
    hat.push(h);
    ohat.push(hit(v.ohat, i) ? 1 : busy > 0.85 && i === 14 && tables[5][i] < 0.5 ? 1 : 0);
  }
  return { kick, clap, hat, ohat };
}

// ---------- bass ----------
// rhythm: 0/1 per step, oct: 1 = an octave up on that hit
export function genBass(vibe, genes, seed, drums) {
  const r = rng(seed);
  const t = Array.from({ length: 16 }, () => [r(), r()]);
  const [busy, , , octave] = genes;
  const rhythm = [];
  const oct = [];
  for (let i = 0; i < 16; i++) {
    const follow = drums ? drums.kick[i] : 0;
    const base = hit(vibe.bass.pattern, i);
    let on = follow || (base && t[i][0] > 0.4 - busy) ? 1 : 0;
    if (!on && i % 2 === 0 && t[i][0] < busy * 0.25) on = 1;
    if (i === 0) on = 1;
    rhythm.push(on);
    oct.push(on && i !== 0 && t[i][1] < octave * 0.55 ? 1 : 0);
  }
  return { rhythm, oct };
}

// ---------- chords ----------
export function genChords(vibe, genes, seed) {
  const r = rng(seed);
  const [busy] = genes;
  const style = vibe.chords.style;
  const rhythm = [];
  for (let i = 0; i < 16; i++) {
    const t = r();
    if (style === "pad") rhythm.push(i === 0 || (busy > 0.6 && i === 8) ? 1 : 0);
    else if (style === "arp") rhythm.push(i % 2 === 0 ? 1 : t < (busy - 0.4) * 1.2 ? 1 : 0);
    else rhythm.push(hit(vibe.chords.pattern, i) ? (i === 0 || t > 0.3 - busy * 0.6 ? 1 : 0) : t < busy * 0.22 && i % 2 === 0 ? 1 : 0);
  }
  rhythm[0] = 1;
  return { style, rhythm };
}

// ---------- melody ----------
// scale-degree helpers (degree 0 = key root, 7 = octave up)
export function chordDegrees(numeral, root, mode) {
  const c = parseNumeral(numeral, root);
  const sc = SCALES[mode].map((s) => (root + s) % 12);
  let d = sc.indexOf(c.rootPc);
  if (d < 0) d = sc.findIndex((pc) => (pc + 1) % 12 === c.rootPc || (pc + 11) % 12 === c.rootPc);
  if (d < 0) d = 0;
  return [d, d + 2, d + 4];
}

// notes: [{ step (absolute in loop), deg, len }]
export function genMelody(song, genes, seed) {
  const r = rng(seed);
  const [busy, range, repeat, high] = genes;
  const bars = song.bars;
  const nNotes = Math.round(3 + busy * 6); // 3..9 notes per bar
  const span = Math.round(4 + range * 6); // how many scale steps the melody may use
  const lo = Math.round(high * 5) - 1;
  const hi = lo + span;
  // 2-3 rhythm cells, strong beats weighted highest
  const weight = (i) => (i % 8 === 0 ? 3 : i % 4 === 0 ? 2 : i % 2 === 0 ? 1.1 : 0.55);
  const makeRhythm = () => {
    const picks = [];
    const pool = Array.from({ length: 16 }, (_, i) => i);
    while (picks.length < nNotes && pool.length) {
      const tot = pool.reduce((a, i) => a + weight(i), 0);
      let x = r() * tot;
      let k = 0;
      for (; k < pool.length; k++) { x -= weight(pool[k]); if (x <= 0) break; }
      picks.push(pool.splice(Math.min(k, pool.length - 1), 1)[0]);
    }
    return picks.sort((a, b) => a - b);
  };
  const cells = [makeRhythm(), makeRhythm(), makeRhythm()];
  const form = [0, 0, 1, 0, 0, 0, 2, 1]; // A A B A ... per bar, a common pop shape
  const notes = [];
  let prev = Math.round((lo + hi) / 2);
  const firstPitches = {};
  for (let b = 0; b < bars; b++) {
    const cellIdx = form[b % form.length];
    const cell = cells[cellIdx];
    const cd = chordDegrees(song.chords[b], song.root, song.mode);
    const reuse = firstPitches[cellIdx] && r() < repeat;
    cell.forEach((st, j) => {
      let deg;
      if (reuse) deg = firstPitches[cellIdx][j];
      else {
        const strong = st % 8 === 0 || j === 0;
        if (strong) {
          // nearest chord tone to where the line is
          let best = cd[0];
          let bd = Infinity;
          for (let o = -14; o <= 14; o += 7) for (const c of cd) { const d = c + o; if (d < lo || d > hi) continue; if (Math.abs(d - prev) < bd) { bd = Math.abs(d - prev); best = d; } }
          deg = best;
        } else if (r() < 0.7) deg = prev + (r() < 0.5 ? 1 : -1);
        else deg = prev + (r() < 0.5 ? 1 : -1) * (2 + Math.floor(r() * 3));
        if (deg > hi) deg = hi - (deg - hi);
        if (deg < lo) deg = lo + (lo - deg);
      }
      prev = deg;
      const next = j + 1 < cell.length ? cell[j + 1] : 16;
      notes.push({ step: b * 16 + st, deg, len: Math.max(1, Math.min(next - st, r() < 0.3 ? 1 : 4)) });
    });
    if (!firstPitches[cellIdx]) firstPitches[cellIdx] = notes.slice(-cell.length).map((n) => n.deg);
  }
  // resolve: last note onto the last chord's root
  if (notes.length) {
    const cd = chordDegrees(song.chords[bars - 1], song.root, song.mode);
    const last = notes[notes.length - 1];
    let best = cd[0];
    for (let o = -14; o <= 14; o += 7) if (Math.abs(cd[0] + o - last.deg) < Math.abs(best - last.deg)) best = cd[0] + o;
    last.deg = best;
  }
  return notes;
}

// ---------- build a part from genes + seed ----------
export function build(part, song, vibe) {
  const p = song.parts[part];
  if (part === "drums") p.pattern = genDrums(vibe, p.genes, p.seed);
  else if (part === "bass") p.pattern = genBass(vibe, p.genes, p.seed, song.parts.drums.pattern);
  else if (part === "chords") p.pattern = genChords(vibe, p.genes, p.seed);
  else if (part === "melody") p.notes = genMelody(song, p.genes, p.seed);
  p.edited = false;
}

export function freshPart(part, vibe) {
  const g = vibe.genes?.[part] || [0.5, 0.6, 0.2, 0.5];
  return {
    genes: [...g],
    seed: newSeed(),
    sound: SOUND_GENES[part].map((s) => s[1]),
    soundLock: SOUND_GENES[part].map(() => false),
    locked: false,
    muted: false,
    edited: false,
    pattern: null,
    notes: []
  };
}

// ---------- mutation ----------
// drift 0..1: how far a mutant wanders from its parent
export function mutate(part, p, song, vibe, drift, r) {
  const m = JSON.parse(JSON.stringify(p));
  const nOps = 1 + Math.floor(drift * 4 * r());
  // gene nudge
  m.genes = m.genes.map((g) => clamp01(g + (r() - 0.5) * drift * 0.6));
  if (part === "melody") {
    if (r() < 0.4 + drift * 0.4) {
      m.seed = newSeed();
      m.notes = genMelody(song, m.genes, m.seed);
    }
    for (let k = 0; k < nOps && m.notes.length; k++) {
      const n = m.notes[Math.floor(r() * m.notes.length)];
      const op = r();
      if (op < 0.5) n.deg += r() < 0.5 ? 1 : -1;
      else if (op < 0.75) n.step = Math.max(0, Math.min(song.bars * 16 - 1, n.step + (r() < 0.5 ? 1 : -1)));
      else n.len = Math.max(1, Math.min(4, n.len + (r() < 0.5 ? 1 : -1)));
    }
    m.edited = false;
    return m;
  }
  // rebuild from nudged genes with a partly new seed, then apply CONGA-style pattern ops
  if (r() < drift) m.seed = newSeed();
  if (part === "drums") m.pattern = genDrums(vibe, m.genes, m.seed);
  else if (part === "bass") m.pattern = genBass(vibe, m.genes, m.seed, song.parts.drums.pattern);
  else m.pattern = genChords(vibe, m.genes, m.seed);
  const rows = part === "drums" ? ["kick", "hat", "ohat"] : part === "bass" ? ["rhythm"] : ["rhythm"];
  for (let k = 0; k < nOps; k++) {
    const row = rows[Math.floor(r() * rows.length)];
    const arr = m.pattern[row];
    const op = r();
    if (op < 0.55) {
      const i = 1 + Math.floor(r() * 15);
      arr[i] = arr[i] ? 0 : 1;
    } else if (op < 0.8 && row !== "kick" && row !== "rhythm") {
      // rotate by one step
      if (r() < 0.5) arr.unshift(arr.pop());
      else arr.push(arr.shift());
    } else if (row === "hat") {
      const i = Math.floor(r() * 16);
      if (arr[i]) arr[i] = 1 + Math.floor(r() * 4);
    }
  }
  if (part === "drums") m.pattern.kick[0] = 1;
  if (part !== "drums" && m.pattern.rhythm) m.pattern.rhythm[0] = 1;
  m.edited = false;
  return m;
}

// ---------- taste ----------
// Features describe a part's character; a linear model learns what you keep vs kill.
export function features(part, p, bars) {
  const f = [...p.genes];
  const dens = (a) => (a ? a.filter(Boolean).length / a.length : 0);
  const off = (a) => (a ? a.filter((v, i) => v && i % 4 !== 0).length / Math.max(1, a.filter(Boolean).length) : 0);
  if (part === "drums" && p.pattern) {
    f.push(dens(p.pattern.kick), off(p.pattern.kick), dens(p.pattern.hat), p.pattern.hat.filter((v) => v > 1).length / 4, dens(p.pattern.ohat));
  } else if (part === "bass" && p.pattern) {
    f.push(dens(p.pattern.rhythm), off(p.pattern.rhythm), dens(p.pattern.oct), 0, 0);
  } else if (part === "chords" && p.pattern) {
    f.push(dens(p.pattern.rhythm), off(p.pattern.rhythm), 0, 0, 0);
  } else if (part === "melody") {
    const n = p.notes || [];
    const steps = n.length > 1 ? n.slice(1).filter((x, i) => Math.abs(x.deg - n[i].deg) <= 1).length / (n.length - 1) : 0;
    const degs = n.map((x) => x.deg);
    f.push(n.length / (bars * 16), steps, degs.length ? (Math.max(...degs) - Math.min(...degs)) / 14 : 0, n.length ? n.reduce((a, x) => a + x.len, 0) / n.length / 4 : 0, 0);
  } else f.push(0, 0, 0, 0, 0);
  return f;
}

export function newTaste() {
  const t = { count: 0 };
  for (const p of PARTS) t[p] = { w: new Array(9).fill(0), mu: new Array(9).fill(0.5), n: 0 };
  return t;
}

export function score(taste, part, p, bars) {
  const m = taste[part];
  const x = features(part, p, bars);
  return x.reduce((a, v, i) => a + m.w[i] * (v - m.mu[i]), 0);
}

export const matchPct = (s) => Math.round(100 / (1 + Math.exp(-4 * s)));

// keep = +1, kill = -1
export function learn(taste, part, p, bars, label) {
  const m = taste[part];
  const x = features(part, p, bars);
  m.n++;
  for (let i = 0; i < x.length; i++) {
    m.mu[i] += (x[i] - m.mu[i]) * 0.15;
    m.w[i] += 0.6 * label * (x[i] - m.mu[i]);
    m.w[i] = Math.max(-3, Math.min(3, m.w[i]));
  }
  taste.count++;
}

// Grows `pool` mutants, shows the `show` best for your taste plus one long shot.
// Mirrors CONGA: a learned model filters candidates so you rate fewer bad ones.
export function variations(part, song, vibe, taste, { drift = 0.4, pool = 30, show = 5 } = {}) {
  const r = rng(newSeed());
  const parent = song.parts[part];
  const cands = [];
  for (let i = 0; i < pool; i++) {
    const m = mutate(part, parent, song, vibe, drift, r);
    cands.push({ p: m, s: score(taste, part, m, song.bars), sig: signature(part, m) });
  }
  cands.sort((a, b) => b.s - a.s);
  const picked = [];
  const seen = new Set([signature(part, parent)]);
  for (const c of cands) {
    if (seen.has(c.sig)) continue;
    seen.add(c.sig);
    picked.push({ ...c, kind: "fit" });
    if (picked.length >= show) break;
  }
  const wild = mutate(part, parent, song, vibe, 1, r);
  picked.push({ p: wild, s: score(taste, part, wild, song.bars), kind: "wild" });
  return picked.map((c) => ({ part: c.p, match: matchPct(c.s), kind: c.kind }));
}

function signature(part, p) {
  return part === "melody" ? JSON.stringify(p.notes.map((n) => [n.step, n.deg])) : JSON.stringify(p.pattern);
}

// VOXROT audio engine (v3)
// ------------------------------------------------------------
// buildGraph(ctx)  : the mixer (buses, vocal chain, reverb, ping-pong delay, master)
// scheduleStep()   : what plays on each 16th note, read live from the song's parts
// Engine           : live clock, keyboard, mic capture, latency calibration, recording
// renderWav()      : the same song rendered offline to a WAV
// Every instrument takes the graph as input, so the same code plays live and offline.
//
// Settings follow common producer practice for hyperpop / rage / bassline:
//   808: sine, pitch drop 30-200 ms, clipped, low shelf after distortion, ducked under the kick
//   supersaw: 7 detuned voices, chords high-passed ~250 Hz so the 808 owns the low end,
//             blend of an 8-bit crushed copy
//   drums: kick always short so the 808 has room; fills on the last beat of every 4th bar
//   vocals: HPF 100 Hz, cut 350 Hz, presence 5 kHz, air 11 kHz, 4:1 comp 8 ms attack,
//           soft saturation, plate reverb with 30 ms pre-delay, ping-pong delay
//   master: glue comp -> soft clip -> limiter
// ------------------------------------------------------------
import { midiToHz, parseNumeral, voiceChord, scaleNote, vibeById } from "./vibes.js";

export const REC_MARGIN = 0.3; // seconds kept before/after a take
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- mixer ----------
export function buildGraph(ctx) {
  const g = { ctx };
  const sr = ctx.sampleRate;
  g.noise = noiseBuffer(sr);

  g.master = ctx.createGain();
  g.master.gain.value = 0.62;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -14;
  glue.ratio.value = 3;
  glue.attack.value = 0.01;
  glue.release.value = 0.15;
  const clip = ctx.createWaveShaper();
  const cc = new Float32Array(2048);
  for (let i = 0; i < cc.length; i++) {
    const x = (i / (cc.length - 1)) * 2 - 1;
    cc[i] = 0.95 * Math.tanh((1.15 * x) / 0.95);
  }
  clip.curve = cc;
  clip.oversample = "2x";
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -1.5;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.001;
  lim.release.value = 0.06;
  g.master.connect(glue);
  glue.connect(clip);
  clip.connect(lim);
  g.out = lim;

  // plate-ish reverb with pre-delay
  g.revSend = ctx.createGain();
  const pre = ctx.createDelay(0.2);
  pre.delayTime.value = 0.03;
  const rev = ctx.createConvolver();
  rev.buffer = impulse(sr, 2.2, 3);
  const revHp = ctx.createBiquadFilter();
  revHp.type = "highpass";
  revHp.frequency.value = 300;
  g.revSend.connect(pre);
  pre.connect(revHp);
  revHp.connect(rev);
  rev.connect(g.master);

  // ping-pong delay
  g.dlySend = ctx.createGain();
  const dl = ctx.createDelay(2);
  const dr = ctx.createDelay(2);
  const fb = ctx.createGain();
  fb.gain.value = 0.38;
  const tone = ctx.createBiquadFilter();
  tone.type = "bandpass";
  tone.frequency.value = 2000;
  tone.Q.value = 0.5;
  const merge = ctx.createChannelMerger(2);
  g.dlySend.connect(tone);
  tone.connect(dl);
  dl.connect(dr);
  dr.connect(fb);
  fb.connect(dl);
  dl.connect(merge, 0, 0);
  dr.connect(merge, 0, 1);
  merge.connect(g.master);
  g.dl = dl;
  g.dr = dr;

  g.bus = {};
  for (const name of ["drums", "bass", "chords", "melody", "vox"]) {
    const b = ctx.createGain();
    b.connect(g.master);
    g.bus[name] = b;
  }

  // drums: kick/clap -> drive -> tone -> bus ; hats -> tone -> bus
  g.drumDrive = ctx.createWaveShaper();
  g.drumTone = ctx.createBiquadFilter();
  g.drumTone.type = "highshelf";
  g.drumTone.frequency.value = 5000;
  g.drumDrive.connect(g.drumTone);
  g.drumTone.connect(g.bus.drums);

  // bass: duck (kick sidechain) -> drive -> low shelf -> tone -> bus
  g.bassIn = ctx.createGain();
  g.bassDuck = ctx.createGain();
  g.bassDrive = ctx.createWaveShaper();
  g.bassDrive.oversample = "2x";
  const shelf = ctx.createBiquadFilter();
  shelf.type = "lowshelf";
  shelf.frequency.value = 65;
  shelf.gain.value = 4;
  g.bassTone = ctx.createBiquadFilter();
  g.bassTone.type = "lowpass";
  g.bassIn.connect(g.bassDuck);
  g.bassDuck.connect(g.bassDrive);
  g.bassDrive.connect(shelf);
  shelf.connect(g.bassTone);
  g.bassTone.connect(g.bus.bass);

  // chords: pump -> highpass 250 -> bus, plus parallel 8-bit crush, plus reverb send
  g.pump = ctx.createGain();
  const chp = ctx.createBiquadFilter();
  chp.type = "highpass";
  chp.frequency.value = 250;
  g.pump.connect(chp);
  chp.connect(g.bus.chords);
  g.chordCrush = ctx.createGain();
  const steps = ctx.createWaveShaper();
  steps.curve = stepCurve(16);
  chp.connect(steps);
  steps.connect(g.chordCrush);
  g.chordCrush.connect(g.bus.chords);
  g.chordRev = ctx.createGain();
  chp.connect(g.chordRev);
  g.chordRev.connect(g.revSend);

  // melody: highpass -> bus, crush + reverb/delay sends
  g.melIn = ctx.createGain();
  const mhp = ctx.createBiquadFilter();
  mhp.type = "highpass";
  mhp.frequency.value = 200;
  g.melIn.connect(mhp);
  mhp.connect(g.bus.melody);
  g.melCrush = ctx.createGain();
  const msteps = ctx.createWaveShaper();
  msteps.curve = stepCurve(12);
  mhp.connect(msteps);
  msteps.connect(g.melCrush);
  g.melCrush.connect(g.bus.melody);
  g.melRev = ctx.createGain();
  mhp.connect(g.melRev);
  g.melRev.connect(g.revSend);
  g.melDly = ctx.createGain();
  mhp.connect(g.melDly);
  g.melDly.connect(g.dlySend);

  // vocal chain
  g.voxIn = ctx.createGain();
  const vhp = ctx.createBiquadFilter();
  vhp.type = "highpass";
  vhp.frequency.value = 100;
  const mud = ctx.createBiquadFilter();
  mud.type = "peaking";
  mud.frequency.value = 350;
  mud.Q.value = 1;
  mud.gain.value = -3;
  const pres = ctx.createBiquadFilter();
  pres.type = "peaking";
  pres.frequency.value = 5000;
  pres.Q.value = 0.8;
  pres.gain.value = 3;
  const air = ctx.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 11000;
  air.gain.value = 4;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.ratio.value = 4;
  comp.attack.value = 0.008;
  comp.release.value = 0.12;
  const sat = ctx.createWaveShaper();
  sat.curve = shaperCurve(0.15);
  g.voxIn.connect(vhp);
  vhp.connect(mud);
  mud.connect(pres);
  pres.connect(air);
  air.connect(comp);
  comp.connect(sat);
  sat.connect(g.bus.vox);
  g.voxRev = ctx.createGain();
  g.voxDly = ctx.createGain();
  sat.connect(g.voxRev);
  sat.connect(g.voxDly);
  g.voxRev.connect(g.revSend);
  g.voxDly.connect(g.dlySend);

  return g;
}

// Pushes the song's mix, dials and SOUND genes into the graph.
export function applyMix(g, song) {
  const m = song.mix;
  const P = song.parts;
  const t = g.ctx.currentTime;
  const set = (p, v) => p.setTargetAtTime(v, t, 0.02);
  const mute = (part) => (P[part] && P[part].muted ? 0 : 1);
  set(g.bus.drums.gain, m.drums * mute("drums"));
  set(g.bus.bass.gain, m.bass * 0.9 * mute("bass"));
  set(g.bus.chords.gain, m.chords * 0.75 * mute("chords"));
  set(g.bus.melody.gain, m.melody * 0.9 * mute("melody"));
  set(g.bus.vox.gain, m.vox * 1.2 * (song.voiceMuted ? 0 : 1));
  set(g.voxRev.gain, m.rev);
  set(g.voxDly.gain, m.dly);
  const eighth = 60 / song.bpm / 2;
  g.dl.delayTime.setValueAtTime(eighth, t);
  g.dr.delayTime.setValueAtTime(eighth, t);
  const ds = P.drums.sound;
  g.drumDrive.curve = shaperCurve(P.drums.genes[1] * 0.5 + ds[4] * 0.5);
  set(g.drumTone.gain, lerp(-8, 6, P.drums.genes[3]));
  const bs = P.bass.sound;
  g.bassDrive.curve = shaperCurve(P.bass.genes[1] * 0.6 + bs[2] * 0.4);
  set(g.bassTone.frequency, lerp(600, 9000, bs[4]));
  const cs = P.chords.sound;
  set(g.chordCrush.gain, cs[3]);
  set(g.chordRev.gain, cs[4] * 0.6);
  const ms = P.melody.sound;
  set(g.melCrush.gain, ms[3]);
  set(g.melRev.gain, ms[4] * 0.6);
  set(g.melDly.gain, ms[4] * 0.35);
}

// Saturation that leaves quiet signals near (1 + amount)x and only grinds loud peaks.
function shaperCurve(amount) {
  const n = 2048;
  const c = new Float32Array(n);
  const k = 1 + amount * 4;
  const makeup = 1 + amount;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(k * x) / k) * makeup;
  }
  return c;
}

function stepCurve(levels) {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.round(x * levels) / levels;
  }
  return c;
}

function impulse(sr, secs, decay) {
  const len = Math.floor(sr * secs);
  const b = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 2 });
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  return b;
}

function noiseBuffer(sr) {
  const b = new AudioBuffer({ length: sr, sampleRate: sr, numberOfChannels: 1 });
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

// ---------- drums ----------
// snd = drums SOUND genes: [kick pitch, kick length, snare snap, hat length, drive]
function kick(g, t, vel, snd) {
  const { ctx } = g;
  const end = lerp(38, 62, snd[0]);
  const len = lerp(0.18, 0.5, snd[1]);
  const o = ctx.createOscillator();
  const a = ctx.createGain();
  o.frequency.setValueAtTime(end * 3.8, t);
  o.frequency.exponentialRampToValueAtTime(end, t + 0.09);
  a.gain.setValueAtTime(1.1 * vel, t);
  a.gain.exponentialRampToValueAtTime(0.001, t + len);
  o.connect(a);
  a.connect(g.drumDrive);
  o.start(t);
  o.stop(t + len + 0.02);
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 2500;
  const na = ctx.createGain();
  na.gain.setValueAtTime(0.4 * vel, t);
  na.gain.exponentialRampToValueAtTime(0.001, t + 0.01);
  n.connect(f);
  f.connect(na);
  na.connect(g.drumDrive);
  n.start(t, Math.random() * 0.5, 0.02);
}

function clap(g, t, vel, snd) {
  const { ctx } = g;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = lerp(1000, 2600, snd[2]);
  f.Q.value = 0.8;
  const a = ctx.createGain();
  a.gain.setValueAtTime(0, t);
  for (let i = 0; i < 3; i++) {
    const ti = t + i * 0.011;
    a.gain.setValueAtTime(0.9 * vel, ti);
    a.gain.exponentialRampToValueAtTime(0.08 * vel + 0.001, ti + 0.009);
  }
  a.gain.setValueAtTime(0.75 * vel, t + 0.033);
  a.gain.exponentialRampToValueAtTime(0.001, t + lerp(0.14, 0.3, snd[2]));
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  n.connect(f);
  f.connect(a);
  a.connect(g.drumDrive);
  const o = ctx.createOscillator();
  const oa = ctx.createGain();
  o.frequency.setValueAtTime(260, t);
  o.frequency.exponentialRampToValueAtTime(180, t + 0.05);
  oa.gain.setValueAtTime(0.35 * vel, t);
  oa.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(oa);
  oa.connect(g.drumDrive);
  o.start(t);
  o.stop(t + 0.1);
  const rs = ctx.createGain();
  rs.gain.value = 0.3;
  a.connect(rs);
  rs.connect(g.revSend);
  n.start(t, Math.random() * 0.5, 0.3);
}

function hat(g, t, open, vel, snd) {
  const { ctx } = g;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = open ? 6500 : 7500;
  const a = ctx.createGain();
  const len = open ? lerp(0.12, 0.35, snd[3]) : lerp(0.018, 0.08, snd[3]);
  a.gain.setValueAtTime((open ? 0.26 : 0.22) * vel, t);
  a.gain.exponentialRampToValueAtTime(0.001, t + len);
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  const p = ctx.createStereoPanner();
  p.pan.value = open ? -0.25 : 0.2;
  n.connect(f);
  f.connect(a);
  a.connect(p);
  p.connect(g.drumTone);
  n.start(t, Math.random() * 0.5, len + 0.01);
}

export function click(g, t, accent, freq) {
  const { ctx } = g;
  const o = ctx.createOscillator();
  const a = ctx.createGain();
  o.frequency.value = freq || (accent ? 1760 : 1320);
  a.gain.setValueAtTime(0.5, t);
  a.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(a);
  a.connect(g.out);
  o.start(t);
  o.stop(t + 0.06);
}

// ---------- bass ----------
// snd = bass SOUND genes: [dive, length, drive, sub, tone]
function bassNote(g, t, dur, midi, sound, stepDur, nextMidi, snd) {
  const { ctx } = g;
  const f = midiToHz(midi);
  const a = ctx.createGain();
  a.connect(g.bassIn);
  dur = dur * lerp(0.4, 1, snd[1]);
  if (sound === "808") {
    const o = ctx.createOscillator();
    const dive = lerp(0.03, 0.2, snd[0]);
    o.frequency.setValueAtTime(f * 2.4, t);
    o.frequency.exponentialRampToValueAtTime(f, t + dive);
    if (nextMidi && nextMidi !== midi) {
      const glide = Math.min(0.15, dur * 0.4);
      o.frequency.setValueAtTime(f, t + dur - glide);
      o.frequency.exponentialRampToValueAtTime(midiToHz(nextMidi), t + dur);
    }
    a.gain.setValueAtTime(0, t);
    a.gain.linearRampToValueAtTime(0.95, t + 0.004);
    a.gain.setValueAtTime(0.95, t + dur * 0.85);
    a.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.01);
    o.connect(a);
    o.start(t);
    o.stop(t + dur + 0.03);
    return;
  }
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 7;
  lp.connect(a);
  const subO = ctx.createOscillator();
  subO.frequency.value = f;
  const subA = ctx.createGain();
  subA.gain.value = lerp(0.2, 0.8, snd[3]);
  subO.connect(subA);
  subA.connect(a);
  subO.start(t);
  subO.stop(t + dur + 0.02);
  const detunes = sound === "reese" ? [-14, 14] : [0];
  for (const dt of detunes) {
    const o = ctx.createOscillator();
    o.type = sound === "reese" ? "sawtooth" : "square";
    o.frequency.value = f;
    o.detune.value = dt;
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  if (sound === "reese") {
    let tt = t;
    let open = true;
    lp.frequency.setValueAtTime(300, t);
    while (tt < t + dur) {
      lp.frequency.linearRampToValueAtTime(open ? 1700 : 260, Math.min(t + dur, tt + stepDur));
      open = !open;
      tt += stepDur;
    }
  } else {
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
  }
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(0.5, t + 0.005);
  a.gain.setValueAtTime(0.5, t + dur * 0.85);
  a.gain.exponentialRampToValueAtTime(0.001, t + dur);
}

// ---------- melodic voices ----------
const ksCache = new Map();
function ksBuffer(midi, sr) {
  const key = midi + "@" + sr;
  if (ksCache.has(key)) return ksCache.get(key);
  const len = Math.floor(sr * 1.4);
  const b = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: 1 });
  const d = b.getChannelData(0);
  const P = Math.max(2, Math.round(sr / midiToHz(midi)));
  const ring = new Float32Array(P);
  for (let i = 0; i < P; i++) ring[i] = Math.random() * 2 - 1;
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const cur = ring[idx];
    ring[idx] = 0.996 * 0.5 * (cur + prev);
    prev = cur;
    d[i] = cur * 0.5;
    idx = (idx + 1) % P;
  }
  ksCache.set(key, b);
  return b;
}

// Plays one note. dur=0 holds until the returned stop(time) is called.
// o: { vel, bright, sub, detune (0..1), attack (s), release (s), from (midi to glide from), glide (s) }
export function voice(g, dest, t, midi, sound, dur, o = {}) {
  const { ctx } = g;
  const vel = o.vel ?? 1;
  const bright = o.bright ?? 0.8;
  const f = midiToHz(midi);
  const a = ctx.createGain();
  a.connect(dest);
  if (sound === "pluck") {
    const s = ctx.createBufferSource();
    s.buffer = ksBuffer(midi, ctx.sampleRate);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2500 + 4000 * bright;
    s.connect(lp);
    lp.connect(a);
    a.gain.value = 0.9 * vel;
    s.start(t);
    const end = dur ? t + Math.max(dur, 0.6) : t + 1.4;
    a.gain.setValueAtTime(0.9 * vel, end - 0.05);
    a.gain.linearRampToValueAtTime(0, end);
    s.stop(end + 0.01);
    return (st) => {
      a.gain.cancelScheduledValues(st);
      a.gain.setTargetAtTime(0, st, 0.15);
      try { s.stop(st + 0.8); } catch (e) { /* already scheduled */ }
    };
  }
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.Q.value = 1.2;
  const top = 1800 + 8000 * bright;
  lp.frequency.setValueAtTime(top, t);
  lp.frequency.exponentialRampToValueAtTime(top * 0.35, t + 0.4);
  lp.connect(a);
  const oscs = [];
  const spread = lerp(6, 30, o.detune ?? 0.5);
  const detunes = sound === "saw" ? [-1, -0.62, -0.28, 0, 0.28, 0.62, 1].map((k) => k * spread) : [-0.3, 0.3].map((k) => k * spread);
  const level = (sound === "saw" ? 0.06 : 0.07) * vel;
  const from = o.from ? midiToHz(o.from) : null;
  for (const dt of detunes) {
    const osc = ctx.createOscillator();
    osc.type = sound === "saw" ? "sawtooth" : "square";
    if (from && o.glide) {
      osc.frequency.setValueAtTime(from, t);
      osc.frequency.exponentialRampToValueAtTime(f, t + o.glide);
    } else osc.frequency.value = f;
    osc.detune.value = dt;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, dt / (spread + 1)));
    osc.connect(pan);
    pan.connect(lp);
    osc.start(t);
    oscs.push(osc);
  }
  if (o.sub) {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = f / 2;
    const sg = ctx.createGain();
    sg.gain.value = 0.25;
    osc.connect(sg);
    sg.connect(lp);
    osc.start(t);
    oscs.push(osc);
  }
  const att = Math.max(0.004, o.attack ?? 0.005);
  const rel = o.release ?? 0.05;
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(level * 5, t + att);
  a.gain.setTargetAtTime(level * 3.2, t + att + 0.005, 0.08);
  const stop = (st) => {
    a.gain.cancelScheduledValues(st);
    a.gain.setValueAtTime(level * 3.2, st);
    a.gain.setTargetAtTime(0, st, Math.max(0.02, rel));
    for (const osc of oscs) {
      try { osc.stop(st + rel * 5 + 0.1); } catch (e) { /* already scheduled */ }
    }
  };
  if (dur) stop(t + dur);
  return stop;
}

// ---------- song helpers ----------
export function songChords(song) {
  return song.chords.map((n) => {
    const c = parseNumeral(n, song.root);
    return { ...c, notes: voiceChord(c) };
  });
}

export function bassMidi(chord, octave) {
  return 12 * (octave + 1) + chord.rootPc + (chord.rootPc > 7 ? -12 : 0);
}

export const melodyMidi = (song, deg) => scaleNote(song.root, song.mode, deg, 4);

function duck(param, t, depth, release) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(depth, t);
  param.linearRampToValueAtTime(1, t + release);
}

// ---------- the step ----------
// step: 0 .. 16*bars-1. Returns a list of {part, row?} hits for the visuals.
export function scheduleStep(g, song, chords, step, t0, stepDur) {
  const v = vibeById(song.vibe);
  const P = song.parts;
  const bars = song.bars;
  const s = step % 16;
  const bar = Math.floor(step / 16) % bars;
  const chord = chords[bar];
  const hits = [];

  // drums
  const D = P.drums;
  const dp = D.pattern;
  const ds = D.sound;
  const hard = D.genes[1];
  const t = t0 + (s % 2 ? D.genes[2] * 0.3 * stepDur : 0);
  const fill = bars >= 4 && bar % 4 === 3 && s >= 12;
  if (dp.kick[s]) {
    if (!D.muted) kick(g, t, lerp(0.75, 1.05, hard), ds);
    duck(g.bassDuck.gain, t, 0.45, 0.12);
    if (v.chords.pump) duck(g.pump.gain, t, 0.2, stepDur * 3);
    hits.push({ part: "drums", row: "kick" });
  }
  if (!D.muted) {
    if (dp.clap[s]) clap(g, t, lerp(0.7, 1, hard), ds);
    if (fill && s === 12 && D.genes[0] > 0.3) {
      for (let k = 0; k < 3; k++) clap(g, t + (k * stepDur * 4) / 3, 0.35 + k * 0.2, ds); // triplet roll into the loop
    }
    const hv = fill && D.genes[0] > 0.45 ? Math.max(dp.hat[s], 2) : dp.hat[s];
    for (let k = 0; k < hv; k++) hat(g, t + (k * stepDur) / hv, false, (k ? 0.7 : 1) * lerp(0.7, 1, hard), ds);
    if (dp.ohat[s]) hat(g, t, true, 1, ds);
  }
  if (dp.clap[s]) hits.push({ part: "drums", row: "clap" });
  if (dp.hat[s]) hits.push({ part: "drums", row: "hat" });

  // bass
  const B = P.bass;
  if (B.pattern.rhythm[s]) {
    let len = 1;
    while (s + len < 16 && !B.pattern.rhythm[s + len]) len++;
    const base = bassMidi(chord, v.bass.octave);
    const midi = base + (B.pattern.oct[s] ? 12 : 0);
    let next = null;
    const slide = B.genes[2];
    if (s + len < 16) {
      const nm = base + (B.pattern.oct[s + len] ? 12 : 0);
      if (slide > 0.5 && nm !== midi) next = nm;
    } else if (slide > 0.25) next = bassMidi(chords[(bar + 1) % bars], v.bass.octave);
    bassNote(g, t, len * stepDur * 0.97, midi, v.bass.sound, stepDur, next, B.sound);
    hits.push({ part: "bass" });
  }

  // chords
  const C = P.chords;
  const cs = C.sound;
  const cOpts = { vel: 0.8, bright: C.genes[1], detune: C.genes[2], attack: cs[1] * 0.3, release: lerp(0.03, 0.6, cs[2]), sub: v.chords.sub };
  const cr = C.pattern.rhythm;
  if (cr[s]) {
    const style = C.pattern.style;
    let len = 1;
    while (s + len < 16 && !cr[s + len]) len++;
    if (style === "pad") {
      for (const n of chord.notes) voice(g, g.pump, t, n, v.chords.sound, len * stepDur * 0.97, cOpts);
    } else if (style === "stabs") {
      const d = stepDur * lerp(0.6, Math.min(4, len), C.genes[3]);
      for (const n of chord.notes) voice(g, g.pump, t, n, v.chords.sound, d, { ...cOpts, vel: 0.85 });
    } else {
      const up = [...chord.notes, chord.notes[0] + 12, chord.notes[1] + 12];
      voice(g, g.pump, t, up[Math.floor(s / 2) % up.length], v.chords.sound, stepDur * lerp(1, 3, C.genes[3]), cOpts);
    }
    hits.push({ part: "chords" });
  }

  // melody
  const M = P.melody;
  const ms = M.sound;
  const notes = M.notes || [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.step !== step) continue;
    const prev = i > 0 ? notes[i - 1] : null;
    const glide = ms[1] > 0.05 && prev && prev.step + prev.len >= n.step - 1 ? lerp(0.02, 0.15, ms[1]) : 0;
    voice(g, g.melIn, t, melodyMidi(song, n.deg), song.lead || v.lead, n.len * stepDur * 0.95, {
      vel: 0.9,
      bright: ms[2],
      detune: ms[0],
      from: glide ? melodyMidi(song, prev.deg) : null,
      glide
    });
    hits.push({ part: "melody" });
  }
  return hits;
}

export function scheduleVox(g, takes, t, loopDur) {
  const srcs = [];
  for (const tk of takes) {
    if (!tk.on || !tk.buffer) continue;
    const src = g.ctx.createBufferSource();
    src.buffer = tk.buffer;
    src.connect(g.voxIn);
    const off = Math.max(0, REC_MARGIN + tk.lat + tk.nudge / 1000);
    src.start(t, off);
    src.stop(t + loopDur);
    srcs.push(src);
  }
  return srcs;
}

export function makeBuffer(channels, sr) {
  const b = new AudioBuffer({ length: channels[0].length, sampleRate: sr, numberOfChannels: channels.length });
  channels.forEach((c, i) => b.copyToChannel(c, i));
  return b;
}

// ---------- live engine ----------
export class Engine {
  constructor() {
    this.ctx = null;
    this.g = null;
    this.song = null;
    this.chords = [];
    this.playing = false;
    this.listeners = {};
    this.voxSources = [];
    this.held = new Map();
    this.capture = null;
  }

  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }
  emit(ev, ...a) {
    for (const fn of this.listeners[ev] || []) fn(...a);
  }

  async ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        this.ctx = new AC({ latencyHint: 0 });
      } catch (e) {
        this.ctx = new AC({ latencyHint: "interactive" });
      }
      this.g = buildGraph(this.ctx);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.g.out.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      if (this.song) this.setSong(this.song);
    }
    if (this.ctx.state !== "running") await this.ctx.resume();
    return this.ctx;
  }

  setSong(song) {
    this.song = song;
    this.chords = songChords(song);
    if (this.g) applyMix(this.g, song);
  }

  get stepDur() {
    return 60 / this.song.bpm / 4;
  }
  get loopSteps() {
    return 16 * this.song.bars;
  }
  get loopDur() {
    return this.stepDur * this.loopSteps;
  }

  async start(countIn = false) {
    await this.ensure();
    if (this.playing) this.stop();
    const t0 = this.ctx.currentTime + 0.12;
    const beat = this.stepDur * 4;
    if (countIn) {
      for (let i = 0; i < 4; i++) {
        click(this.g, t0 + i * beat, i === 0);
        this.at(t0 + i * beat, () => this.emit("count", 4 - i));
      }
      this.at(t0 + 4 * beat, () => this.emit("count", 0));
    }
    this.loopStart = t0 + (countIn ? 4 * beat : 0);
    this.nextTime = this.loopStart;
    this.step = 0;
    this.playing = true;
    this.timer = setInterval(() => this.tick(), 25);
    this.tick();
    this.wake();
    this.emit("play", true);
    return this.loopStart;
  }

  stop() {
    this.playing = false;
    clearInterval(this.timer);
    for (const s of this.voxSources) {
      try { s.stop(); } catch (e) { /* already stopped */ }
    }
    this.voxSources = [];
    if (this.g) {
      for (const p of [this.g.pump.gain, this.g.bassDuck.gain]) {
        p.cancelScheduledValues(0);
        p.value = 1;
      }
    }
    this.emit("play", false);
    this.emit("step", -1, []);
    if (this.wakeLock) {
      this.wakeLock.release().catch(() => {});
      this.wakeLock = null;
    }
  }

  async wake() {
    try {
      if (navigator.wakeLock && !this.wakeLock) this.wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) { /* not allowed, fine */ }
  }

  at(time, fn) {
    setTimeout(fn, Math.max(0, (time - this.ctx.currentTime) * 1000));
  }

  tick() {
    const ahead = 0.3; // seconds scheduled in advance: slack for busy phones
    while (this.playing && this.nextTime < this.ctx.currentTime + ahead) {
      const steps = this.loopSteps;
      const st = this.step % steps;
      const t = this.nextTime;
      const hits = scheduleStep(this.g, this.song, this.chords, st, t, this.stepDur);
      if (st === 0) {
        const now = this.ctx.currentTime;
        this.voxSources = this.voxSources.filter((s) => s._end > now);
        const srcs = scheduleVox(this.g, this.song.takes, t, this.loopDur);
        for (const s of srcs) s._end = t + this.loopDur;
        this.voxSources.push(...srcs);
        this.emit("loop", t);
      }
      this.at(t, () => this.emit("step", st, hits));
      this.nextTime += this.stepDur;
      this.step = (st + 1) % steps;
    }
  }

  // loop position in 16ths (float)
  position() {
    if (!this.playing) return null;
    const p = (this.ctx.currentTime - this.loopStart) / this.stepDur;
    const n = this.loopSteps;
    return ((p % n) + n) % n;
  }

  async auditionChord(bar) {
    await this.ensure();
    const v = vibeById(this.song.vibe);
    const t = this.ctx.currentTime + 0.01;
    const c = this.chords[bar];
    for (const n of c.notes) voice(this.g, this.g.pump, t, n, v.chords.sound, 0.9, { vel: 0.8, bright: 0.8 });
    bassNote(this.g, t, 0.6, bassMidi(c, v.bass.octave), v.bass.sound, this.stepDur, null, this.song.parts.bass.sound);
  }

  async noteDown(id, deg) {
    await this.ensure();
    const v = vibeById(this.song.vibe);
    const ms = this.song.parts.melody.sound;
    const stop = voice(this.g, this.g.melIn, this.ctx.currentTime + 0.005, melodyMidi(this.song, deg), this.song.lead || v.lead, 0, { bright: ms[2], detune: ms[0] });
    this.held.set(id, stop);
  }
  noteUp(id) {
    const stop = this.held.get(id);
    if (stop && this.ctx) stop(this.ctx.currentTime + 0.01);
    this.held.delete(id);
  }

  // ----- mic -----
  async openMic() {
    await this.ensure();
    if (this.mic) return this.mic;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
    });
    const ctx = this.ctx;
    const src = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node;
    const onChunk = (t, data) => {
      let s = 0;
      for (let i = 0; i < data.length; i += 4) s += data[i] * data[i];
      this.emit("level", Math.sqrt(s / (data.length / 4)), data);
      const c = this.capture;
      if (!c) return;
      c.chunks.push({ t, data });
      if (t > c.endTime) this.finishCapture();
    };
    try {
      await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
      node = new AudioWorkletNode(ctx, "voxrot-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e) => onChunk(e.data.t, e.data.data);
    } catch (e) {
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => {
        const data = new Float32Array(ev.inputBuffer.getChannelData(0));
        onChunk(ctx.currentTime - data.length / ctx.sampleRate, data);
      };
    }
    src.connect(node);
    node.connect(sink);
    this.mic = { stream, src, node };
    return this.mic;
  }

  captureWindow(from, to) {
    return new Promise((resolve) => {
      this.capture = { chunks: [], from, to, endTime: to + 0.15, resolve };
    });
  }

  finishCapture() {
    const c = this.capture;
    this.capture = null;
    const sr = this.ctx.sampleRate;
    const len = Math.round((c.to - c.from) * sr);
    const out = new Float32Array(len);
    for (const ch of c.chunks) {
      const start = Math.round((ch.t - c.from) * sr);
      for (let i = 0; i < ch.data.length; i++) {
        const j = start + i;
        if (j >= 0 && j < len) out[j] = ch.data[i];
      }
    }
    c.resolve(out);
  }

  async calibrate() {
    await this.openMic();
    if (this.playing) this.stop();
    const t0 = this.ctx.currentTime + 0.3;
    const gap = 0.4;
    const N = 6;
    for (let i = 0; i < N; i++) click(this.g, t0 + i * gap, true, 2000);
    const rec = await this.captureWindow(t0 - 0.05, t0 + N * gap + 0.3);
    const { findOnsets } = await import("./dsp.js");
    const sr = this.ctx.sampleRate;
    const onsets = findOnsets(rec, sr, Math.round(sr * gap * 0.6));
    const delays = [];
    for (const o of onsets) {
      const tt = t0 - 0.05 + o / sr;
      const i = Math.round((tt - t0) / gap);
      const d = tt - (t0 + i * gap);
      if (i >= 0 && i < N && d > -0.01 && d < 0.35) delays.push(d);
    }
    if (delays.length < 3) return null;
    delays.sort((a, b) => a - b);
    return delays[delays.length >> 1];
  }

  async record(lat) {
    await this.openMic();
    const loopStart = await this.start(true);
    this.emit("rec", true, loopStart);
    const raw = await this.captureWindow(loopStart - REC_MARGIN, loopStart + this.loopDur + REC_MARGIN + lat);
    this.emit("rec", false);
    if (!raw) return null;
    return { raw, sr: this.ctx.sampleRate };
  }

  cancelRecord() {
    if (this.capture) {
      const r = this.capture.resolve;
      this.capture = null;
      r(null);
    }
  }
}

// ---------- export ----------
export async function renderWav(song, loops = 2) {
  const sr = 44100;
  const stepDur = 60 / song.bpm / 4;
  const steps = 16 * song.bars;
  const loopDur = stepDur * steps;
  const len = Math.ceil(sr * (loopDur * loops + 2.5));
  const ctx = new OfflineAudioContext(2, len, sr);
  const g = buildGraph(ctx);
  g.out.connect(ctx.destination);
  applyMix(g, song);
  const chords = songChords(song);
  const t0 = 0.05;
  for (let l = 0; l < loops; l++) {
    const lt = t0 + l * loopDur;
    for (let s = 0; s < steps; s++) scheduleStep(g, song, chords, s, lt + s * stepDur, stepDur);
    scheduleVox(g, song.takes, lt, loopDur);
  }
  const out = await ctx.startRendering();
  return encodeWav(out);
}

function encodeWav(buf) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const sr = buf.sampleRate;
  const bytes = 44 + n * ch * 2;
  const v = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  v.setUint32(4, bytes - 8, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * ch * 2, true);
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([v], { type: "audio/wav" });
}

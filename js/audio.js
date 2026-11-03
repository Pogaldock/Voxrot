// VOXROT audio engine
// ------------------------------------------------------------
// buildGraph(ctx)  : the mixer (buses, vocal chain, reverb, ping-pong delay, master)
// scheduleStep()   : what plays on each 16th note (drums, 808, chords, keys)
// Engine           : live clock, keyboard, mic capture, latency calibration, recording
// renderWav()      : the same song rendered offline to a WAV
// Every instrument takes the graph as input, so the same code plays live and offline.
//
// Settings follow common producer practice for hyperpop / rage / bassline:
//   808: sine, pitch drop ~60 ms, clipped, low shelf after distortion, ducked under the kick
//   supersaw: 7 detuned voices, chords high-passed ~250 Hz so the 808 owns the low end,
//             30-40% blend of an 8-bit crushed copy
//   vocals: HPF 100 Hz, cut 350 Hz, presence 5 kHz, air 11 kHz, 4:1 comp 8 ms attack,
//           soft saturation, plate reverb with 30 ms pre-delay, ping-pong delay
//   master: glue comp -> soft clip -> limiter
// ------------------------------------------------------------
import { midiToHz, parseNumeral, voiceChord, scaleNote, vibeById } from "./vibes.js";

export const BARS = 4;
export const LOOP_STEPS = 16 * BARS;
export const REC_MARGIN = 0.3; // seconds kept before/after a take

const hit = (pattern, s) => !!pattern && pattern[s % 16] === "x";

// ---------- mixer ----------
export function buildGraph(ctx) {
  const g = { ctx };
  const sr = ctx.sampleRate;
  g.noise = noiseBuffer(sr);

  // master: glue -> soft clip -> limiter
  g.master = ctx.createGain();
  g.master.gain.value = 0.62;
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -14;
  glue.ratio.value = 3;
  glue.attack.value = 0.01;
  glue.release.value = 0.15;
  // master soft clip: unity-ish below -6 dB, rounds peaks off toward 0.95
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

  // ping-pong delay (left, then right)
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

  // buses
  g.bus = {};
  for (const name of ["drums", "bass", "chords", "keys", "vox"]) {
    const b = ctx.createGain();
    b.connect(g.master);
    g.bus[name] = b;
  }

  // drums: drive on kick/clap
  g.drumDrive = ctx.createWaveShaper();
  g.drumDrive.connect(g.bus.drums);

  // bass: duck (kick sidechain) -> drive -> low shelf -> bus
  g.bassIn = ctx.createGain();
  g.bassDuck = ctx.createGain();
  g.bassDrive = ctx.createWaveShaper();
  g.bassDrive.oversample = "2x";
  const shelf = ctx.createBiquadFilter();
  shelf.type = "lowshelf";
  shelf.frequency.value = 65;
  shelf.gain.value = 4;
  g.bassIn.connect(g.bassDuck);
  g.bassDuck.connect(g.bassDrive);
  g.bassDrive.connect(shelf);
  shelf.connect(g.bus.bass);

  // chords: pump -> highpass 250 -> bus, plus parallel 8-bit crush
  g.pump = ctx.createGain();
  const chp = ctx.createBiquadFilter();
  chp.type = "highpass";
  chp.frequency.value = 250;
  g.pump.connect(chp);
  chp.connect(g.bus.chords);
  g.chordCrush = ctx.createGain();
  g.chordCrush.gain.value = 0;
  const steps = ctx.createWaveShaper();
  steps.curve = stepCurve(16);
  chp.connect(steps);
  steps.connect(g.chordCrush);
  g.chordCrush.connect(g.bus.chords);
  const chordRev = ctx.createGain();
  chordRev.gain.value = 0.18;
  chp.connect(chordRev);
  chordRev.connect(g.revSend);

  // keys
  g.keysIn = ctx.createGain();
  const khp = ctx.createBiquadFilter();
  khp.type = "highpass";
  khp.frequency.value = 200;
  g.keysIn.connect(khp);
  khp.connect(g.bus.keys);
  const keysRev = ctx.createGain();
  keysRev.gain.value = 0.25;
  khp.connect(keysRev);
  keysRev.connect(g.revSend);

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

export function applyMix(g, song) {
  const m = song.mix;
  const t = g.ctx.currentTime;
  const set = (p, v) => p.setTargetAtTime(v, t, 0.02);
  set(g.bus.drums.gain, m.drums);
  set(g.bus.bass.gain, m.bass * 0.9);
  set(g.bus.chords.gain, m.chords * 0.75);
  set(g.bus.keys.gain, m.keys * 0.9);
  set(g.bus.vox.gain, m.vox * 1.2);
  set(g.voxRev.gain, m.rev);
  set(g.voxDly.gain, m.dly);
  const eighth = 60 / song.bpm / 2;
  g.dl.delayTime.setValueAtTime(eighth, t);
  g.dr.delayTime.setValueAtTime(eighth, t);
  const v = vibeById(song.vibe);
  g.drumDrive.curve = shaperCurve(v.drums.drive);
  g.bassDrive.curve = shaperCurve(v.bass.drive);
  set(g.chordCrush.gain, v.chords.crush || 0);
}

// Saturation that leaves quiet signals at (1 + amount)x and only grinds the loud peaks.
// k = how hard the peaks bend; small-signal gain stays modest so nothing explodes in level.
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
      lp += 0.35 * (Math.random() * 2 - 1 - lp); // darker tail, like a plate
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
function kick(g, t) {
  const { ctx } = g;
  const o = ctx.createOscillator();
  const a = ctx.createGain();
  o.frequency.setValueAtTime(180, t);
  o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
  a.gain.setValueAtTime(1.1, t);
  a.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  o.connect(a);
  a.connect(g.drumDrive);
  o.start(t);
  o.stop(t + 0.34);
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = 2500;
  const na = ctx.createGain();
  na.gain.setValueAtTime(0.4, t);
  na.gain.exponentialRampToValueAtTime(0.001, t + 0.01);
  n.connect(f);
  f.connect(na);
  na.connect(g.drumDrive);
  n.start(t, Math.random() * 0.5, 0.02);
}

function clap(g, t) {
  const { ctx } = g;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 1500;
  f.Q.value = 0.8;
  const a = ctx.createGain();
  a.gain.setValueAtTime(0, t);
  for (let i = 0; i < 3; i++) {
    const ti = t + i * 0.011;
    a.gain.setValueAtTime(0.9, ti);
    a.gain.exponentialRampToValueAtTime(0.08, ti + 0.009);
  }
  a.gain.setValueAtTime(0.75, t + 0.033);
  a.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  n.connect(f);
  f.connect(a);
  a.connect(g.drumDrive);
  // snare body layered under the clap
  const o = ctx.createOscillator();
  const oa = ctx.createGain();
  o.frequency.setValueAtTime(260, t);
  o.frequency.exponentialRampToValueAtTime(180, t + 0.05);
  oa.gain.setValueAtTime(0.35, t);
  oa.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(oa);
  oa.connect(g.drumDrive);
  o.start(t);
  o.stop(t + 0.1);
  const rs = ctx.createGain();
  rs.gain.value = 0.3;
  a.connect(rs);
  rs.connect(g.revSend);
  n.start(t, Math.random() * 0.5, 0.26);
}

function hat(g, t, open) {
  const { ctx } = g;
  const f = ctx.createBiquadFilter();
  f.type = "highpass";
  f.frequency.value = open ? 6500 : 7500;
  const a = ctx.createGain();
  const len = open ? 0.2 : 0.035;
  a.gain.setValueAtTime(open ? 0.26 : 0.22, t);
  a.gain.exponentialRampToValueAtTime(0.001, t + len);
  const n = ctx.createBufferSource();
  n.buffer = g.noise;
  const p = ctx.createStereoPanner();
  p.pan.value = open ? -0.25 : 0.2;
  n.connect(f);
  f.connect(a);
  a.connect(p);
  p.connect(g.bus.drums);
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
// nextMidi: when set and glide is on, the 808 slides into it at the end of the note
function bassNote(g, t, dur, midi, sound, stepDur, nextMidi) {
  const { ctx } = g;
  const f = midiToHz(midi);
  const a = ctx.createGain();
  a.connect(g.bassIn);
  if (sound === "808") {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f * 2.4, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
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
  const subO = ctx.createOscillator(); // sine sub under every bass, mids on top
  subO.frequency.value = f;
  const subA = ctx.createGain();
  subA.gain.value = 0.5;
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
export function voice(g, dest, t, midi, sound, dur, vel = 1, bright = 0.8, sub = false) {
  const { ctx } = g;
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
  const detunes = sound === "saw" ? [-21, -13, -6, 0, 6, 13, 21] : [-6, 6];
  const level = (sound === "saw" ? 0.06 : 0.07) * vel;
  for (const dt of detunes) {
    const o = ctx.createOscillator();
    o.type = sound === "saw" ? "sawtooth" : "square";
    o.frequency.value = f;
    o.detune.value = dt;
    const pan = ctx.createStereoPanner();
    pan.pan.value = dt / 24;
    o.connect(pan);
    pan.connect(lp);
    o.start(t);
    oscs.push(o);
  }
  if (sub) {
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = f / 2;
    const sg = ctx.createGain();
    sg.gain.value = 0.25;
    o.connect(sg);
    sg.connect(lp);
    o.start(t);
    oscs.push(o);
  }
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(level * 5, t + 0.005);
  a.gain.setTargetAtTime(level * 3.2, t + 0.01, 0.08);
  const stop = (st) => {
    a.gain.cancelScheduledValues(st);
    a.gain.setValueAtTime(level * 3.2, st);
    a.gain.setTargetAtTime(0, st, 0.05);
    for (const o of oscs) {
      try { o.stop(st + 0.4); } catch (e) { /* already scheduled */ }
    }
  };
  if (dur) stop(t + dur);
  return stop;
}

// ---------- song helpers ----------
export function songChords(song) {
  return song.prog.map((n) => {
    const c = parseNumeral(n, song.root);
    return { ...c, notes: voiceChord(c) };
  });
}

export function bassMidi(chord, octave) {
  return 12 * (octave + 1) + chord.rootPc + (chord.rootPc > 7 ? -12 : 0);
}

function duck(param, t, depth, release) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(depth, t);
  param.linearRampToValueAtTime(1, t + release);
}

// ---------- the step ----------
export function scheduleStep(g, song, chords, step, t0, stepDur) {
  const v = vibeById(song.vibe);
  const s = step % 16;
  const bar = Math.floor(step / 16) % BARS;
  const chord = chords[bar];
  const muted = song.mute || {};
  const t = t0 + (s % 2 ? (song.swing ?? v.swing ?? 0) * stepDur : 0);
  const d = v.drums;

  if (hit(d.kick, s)) {
    if (!muted.drums) kick(g, t);
    duck(g.bassDuck.gain, t, 0.45, 0.12);
    if (v.chords.pump) duck(g.pump.gain, t, 0.2, stepDur * 3);
  }
  if (!muted.drums) {
    if (hit(d.clap, s)) clap(g, t);
    if (hit(d.hat, s)) hat(g, t, false);
    if (hit(d.ohat, s)) hat(g, t, true);
  }

  if (!muted.bass && hit(v.bass.pattern, s)) {
    let len = 1;
    while (s + len < 16 && !hit(v.bass.pattern, s + len)) len++;
    const isLast = s + len >= 16;
    let next = null;
    if (v.bass.glide && isLast) next = bassMidi(chords[(bar + 1) % BARS], v.bass.octave);
    bassNote(g, t, len * stepDur * 0.97, bassMidi(chord, v.bass.octave), v.bass.sound, stepDur, next);
  }

  if (!muted.chords) {
    const c = v.chords;
    if (c.style === "pad" && s === 0) {
      for (const n of chord.notes) voice(g, g.pump, t, n, c.sound, stepDur * 15.5, 0.8, c.bright);
    } else if (c.style === "stabs" && hit(c.pattern, s)) {
      for (const n of chord.notes) voice(g, g.pump, t, n, c.sound, stepDur * 1.4, 0.85, c.bright, c.sub);
    } else if (c.style === "arp" && hit(c.pattern, s)) {
      const up = [...chord.notes, chord.notes[0] + 12, chord.notes[1] + 12];
      const idx = Math.floor(s / 2) % up.length;
      voice(g, g.pump, t, up[idx], c.sound, stepDur * 2, 0.8, c.bright);
    }
  }

  if (!muted.keys) {
    for (const ev of song.keysLoop) {
      if (ev.step === step) {
        voice(g, g.keysIn, t, scaleNote(song.root, song.mode, ev.deg, song.keyOct), song.lead || v.lead, stepDur * 2, 0.9, 0.9);
      }
    }
  }
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
  get loopDur() {
    return this.stepDur * LOOP_STEPS;
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
    this.emit("step", -1);
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
    const ahead = 0.15;
    while (this.playing && this.nextTime < this.ctx.currentTime + ahead) {
      const st = this.step;
      const t = this.nextTime;
      scheduleStep(this.g, this.song, this.chords, st, t, this.stepDur);
      if (st === 0) {
        const now = this.ctx.currentTime;
        this.voxSources = this.voxSources.filter((s) => s._end > now);
        const srcs = scheduleVox(this.g, this.song.takes, t, this.loopDur);
        for (const s of srcs) s._end = t + this.loopDur;
        this.voxSources.push(...srcs);
      }
      this.at(t, () => this.emit("step", st, t));
      this.nextTime += this.stepDur;
      this.step = (st + 1) % LOOP_STEPS;
    }
  }

  // loop position in 16ths (float), for quantizing key presses
  position() {
    if (!this.playing) return null;
    const p = (this.ctx.currentTime - this.loopStart) / this.stepDur;
    return ((p % LOOP_STEPS) + LOOP_STEPS) % LOOP_STEPS;
  }

  async auditionChord(i) {
    await this.ensure();
    const v = vibeById(this.song.vibe);
    const t = this.ctx.currentTime + 0.01;
    for (const n of this.chords[i].notes) voice(this.g, this.g.pump, t, n, v.chords.sound, 0.9, 0.8, v.chords.bright);
    bassNote(this.g, t, 0.6, bassMidi(this.chords[i], v.bass.octave), v.bass.sound, this.stepDur);
  }

  async keyDown(id, deg) {
    await this.ensure();
    const v = vibeById(this.song.vibe);
    const midi = scaleNote(this.song.root, this.song.mode, deg, this.song.keyOct);
    const stop = voice(this.g, this.g.keysIn, this.ctx.currentTime + 0.005, midi, this.song.lead || v.lead, 0, 1, 0.9);
    this.held.set(id, stop);
  }
  keyUp(id) {
    const stop = this.held.get(id);
    if (stop && this.ctx) stop(this.ctx.currentTime + 0.01);
    this.held.delete(id);
  }

  // ----- mic -----
  // AudioWorklet capture (audio thread, exact timestamps); ScriptProcessor fallback.
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

  // collects mic audio between `from` and `to` (audio-clock seconds)
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

  // Measures the real delay between "the app plays a sound" and "the mic hears it"
  // by playing 6 beeps and timing them. Needs the phone speaker (headphones off).
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

  // Records one loop after a 1-bar count-in. Returns { raw, sr } or null if cancelled.
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
export async function renderWav(song, loops = 4) {
  const sr = 44100;
  const stepDur = 60 / song.bpm / 4;
  const loopDur = stepDur * LOOP_STEPS;
  const len = Math.ceil(sr * (loopDur * loops + 2.5));
  const ctx = new OfflineAudioContext(2, len, sr);
  const g = buildGraph(ctx);
  g.out.connect(ctx.destination);
  applyMix(g, song);
  const chords = songChords(song);
  const t0 = 0.05;
  for (let l = 0; l < loops; l++) {
    const lt = t0 + l * loopDur;
    for (let s = 0; s < LOOP_STEPS; s++) scheduleStep(g, song, chords, s, lt + s * stepDur, stepDur);
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

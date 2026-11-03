// VOXROT interface
import { VIBES, SWAP_OPTIONS, NOTE_NAMES, vibeById, parseNumeral, scalePitchClasses, keyLabel } from "./vibes.js";
import { Engine, REC_MARGIN, LOOP_STEPS, makeBuffer, renderWav } from "./audio.js";
import { processTake, detectPitch, snapToScale } from "./dsp.js";

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const DEFAULT_MIX = { drums: 0.9, bass: 0.95, chords: 0.7, keys: 0.75, vox: 1, rev: 0.28, dly: 0.16 };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* no haptics */ } };

let song = newSong("crush");
let recording = false;
let keysRecArmed = false;
let processing = 0;
let lastTakeId = null;
let livePitch = [];

// ---------- song ----------
function newSong(vibeId) {
  const v = vibeById(vibeId);
  return {
    id: "current",
    name: "",
    vibe: v.id,
    bpm: v.bpm,
    swing: v.swing,
    root: v.root,
    mode: v.mode,
    prog: pick(v.progressions).split(" "),
    keyOct: 4,
    lead: v.lead,
    keysLoop: [],
    mix: { ...DEFAULT_MIX },
    fx: { ...v.fx },
    mute: {},
    takes: []
  };
}

function setVibe(id) {
  const v = vibeById(id);
  const hasTakes = song.takes.length > 0;
  song.vibe = v.id;
  song.prog = pick(v.progressions).split(" ");
  song.lead = v.lead;
  song.fx = { ...v.fx };
  song.swing = v.swing;
  if (!hasTakes) {
    song.bpm = v.bpm;
    song.root = v.root;
    song.mode = v.mode;
  } else {
    toast(`Kept ${song.bpm} BPM and ${keyLabel(song.root, song.mode)} so your vocals stay in time`);
  }
  changed({ reprocess: true });
}

function reroll() {
  const v = vibeById(song.vibe);
  const options = v.progressions.filter((p) => p !== song.prog.join(" "));
  const prog = pick(options.length ? options : v.progressions).split(" ");
  if (Math.random() < 0.35) {
    const i = Math.floor(Math.random() * prog.length);
    prog[i] = pick(SWAP_OPTIONS[song.mode]);
  }
  song.prog = prog;
  changed();
  glitch(true);
}

function swapChord(i) {
  const opts = SWAP_OPTIONS[song.mode].filter((n) => n !== song.prog[i]);
  song.prog[i] = pick(opts);
  buzz(20);
  changed();
  engine.auditionChord(i);
}

// everything that changes the song funnels through here
let saveTimer = null;
function changed({ reprocess = false, structure = true } = {}) {
  engine.setSong(song);
  if (structure) render();
  if (reprocess) reprocessAll();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSong("current"), 700);
}

// ---------- takes ----------
function guessLatency() {
  const stored = Number(lsGet("voxrot.lat"));
  if (stored > 0) return stored;
  const c = engine.ctx;
  const g = (c && (c.outputLatency || 0) + (c.baseLatency || 0)) || 0;
  return Math.max(0.06, g + 0.02);
}

async function processOne(tk) {
  const sr = tk.sr;
  const out = processTake(tk, {
    scalePcs: scalePitchClasses(song.root, song.mode),
    tune: song.fx.tune,
    oct: song.fx.oct,
    chip: song.fx.chip,
    wide: song.fx.wide,
    crush: song.fx.crush,
    stutter: song.fx.stutter,
    gridStart: Math.round((REC_MARGIN + tk.lat + tk.nudge / 1000) * sr),
    stepLen: (60 / song.bpm / 4) * sr,
    steps: LOOP_STEPS,
    seed: tk.seed
  });
  tk.buffer = makeBuffer(out, sr);
}

let reprocessToken = 0;
async function reprocessAll() {
  if (!song.takes.length) return;
  const token = ++reprocessToken;
  processing++;
  renderVoxLabel();
  for (const tk of song.takes) {
    await new Promise((r) => setTimeout(r, 0));
    if (token !== reprocessToken) break;
    await processOne(tk);
  }
  processing--;
  renderVoxLabel();
  renderTakes();
}

async function doRecord() {
  if (recording) {
    engine.cancelRecord();
    return;
  }
  try {
    recording = true;
    livePitch = [];
    renderTransport();
    const lat = guessLatency();
    const res = await engine.record(lat);
    recording = false;
    renderTransport();
    if (!res) {
      toast("Take cancelled");
      return;
    }
    const tk = {
      id: "t" + Date.now().toString(36),
      raw: res.raw,
      sr: res.sr,
      lat,
      nudge: 0,
      on: true,
      seed: Math.floor(Math.random() * 1e9)
    };
    processing++;
    renderVoxLabel();
    await new Promise((r) => setTimeout(r, 0));
    await processOne(tk);
    processing--;
    song.takes.push(tk);
    lastTakeId = tk.id;
    toast(`TAKE ${String(song.takes.length).padStart(2, "0")} IN`);
    buzz([30, 40, 30]);
    changed({ structure: false });
    render();
  } catch (e) {
    recording = false;
    renderTransport();
    toast(e && e.name === "NotAllowedError" ? "Mic blocked. Allow the microphone for this site in Chrome settings." : "Couldn't record: " + (e.message || e));
  }
}

// ---------- rendering ----------
function render() {
  const v = vibeById(song.vibe);
  $("bpmChip").textContent = `${song.bpm} BPM`;
  $("keyChip").textContent = keyLabel(song.root, song.mode);

  // vibes
  const vibes = $("vibes");
  vibes.replaceChildren(
    ...VIBES.map((vb) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "vibe" + (vb.id === song.vibe ? " on" : "");
      b.textContent = vb.name;
      b.setAttribute("aria-pressed", vb.id === song.vibe);
      b.onclick = () => { setVibe(vb.id); buzz(10); };
      return b;
    })
  );

  // chords
  const chords = song.prog.map((n) => parseNumeral(n, song.root));
  $("numerals").textContent = song.prog.join(" ");
  const pads = $("pads");
  pads.replaceChildren(
    ...chords.map((c, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pad";
      b.dataset.i = i;
      b.innerHTML = `<span class="pname"></span><span class="pnum"></span>`;
      b.querySelector(".pname").textContent = c.name;
      b.querySelector(".pnum").textContent = c.numeral;
      bindHold(b, () => engine.auditionChord(i), () => swapChord(i));
      return b;
    })
  );

  // steps row
  if (!$("steps").children.length) {
    for (let i = 0; i < 16; i++) $("steps").appendChild(document.createElement("i"));
  }

  // keys
  const scaleName = `${NOTE_NAMES[song.root]} ${song.mode.toUpperCase()}`;
  $("keysScale").textContent = scaleName;
  const pcs = scalePitchClasses(song.root, song.mode);
  const keys = $("keys");
  keys.replaceChildren(
    ...Array.from({ length: 8 }, (_, d) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "key";
      b.dataset.deg = d;
      b.textContent = NOTE_NAMES[pcs[d % 7]];
      b.setAttribute("aria-label", `Play ${NOTE_NAMES[pcs[d % 7]]}`);
      return b;
    })
  );
  $("keysRec").classList.toggle("on", keysRecArmed);
  $("keysRec").setAttribute("aria-pressed", keysRecArmed);
  $("keysRec").textContent = keysRecArmed ? "LOOPING" : "LOOP IT";
  $("keysClear").disabled = !song.keysLoop.length;

  // fx
  for (const b of document.querySelectorAll("[data-fx]")) {
    const k = b.dataset.fx;
    if (k === "tune") {
      b.textContent = "TUNE: " + song.fx.tune.toUpperCase();
      b.classList.toggle("on", song.fx.tune !== "off");
    } else {
      b.classList.toggle("on", !!song.fx[k]);
      b.setAttribute("aria-pressed", !!song.fx[k]);
    }
  }
  for (const b of document.querySelectorAll("[data-mute]")) {
    const m = !!song.mute[b.dataset.mute];
    b.classList.toggle("on", m);
    b.setAttribute("aria-pressed", m);
  }

  // mix
  for (const k of Object.keys(DEFAULT_MIX)) {
    const el = $("m-" + k);
    if (el) el.value = song.mix[k];
  }
  const locked = song.takes.length > 0;
  $("bpm").value = song.bpm;
  $("bpm").disabled = locked;
  $("bpmVal").textContent = `${song.bpm} BPM`;
  $("bpmLock").textContent = locked ? "LOCKED: VOCALS RECORDED AT THIS TEMPO" : "";
  $("swing").value = song.swing;
  $("swingVal").textContent = `SWING ${Math.round(song.swing * 100)}%`;
  $("root").value = song.root;
  $("mode").value = song.mode;
  $("lead").value = song.lead;
  $("songName").value = song.name || "";

  renderVoxLabel();
  renderTakes();
  renderTransport();
}

function renderVoxLabel() {
  const n = song.takes.length;
  $("voxLabel").textContent = processing
    ? "VOX · PROCESSING"
    : n
      ? `VOX · ${n} TAKE${n > 1 ? "S" : ""} · SNAPPED`
      : "VOX · NO TAKES YET";
  $("voxTime").textContent = lsGet("voxrot.lat") ? `SYNC ${Math.round(Number(lsGet("voxrot.lat")) * 1000)} MS` : "HEADPHONES ON";
}

function renderTransport() {
  $("play").classList.toggle("on", engine.playing);
  $("play").setAttribute("aria-label", engine.playing ? "Stop" : "Play");
  $("rec").classList.toggle("on", recording);
  $("rec").setAttribute("aria-label", recording ? "Cancel recording" : "Record vocal");
  document.body.classList.toggle("recording", recording);
}

function renderTakes() {
  const box = $("takes");
  if (!song.takes.length) {
    box.innerHTML = `<p class="empty">No takes yet. Hit the eye on MAKE, wait for the 4 clicks, sing over one loop.</p>`;
    return;
  }
  box.replaceChildren(
    ...song.takes.map((tk, i) => {
      const row = document.createElement("div");
      row.className = "take" + (tk.on ? "" : " off");
      const name = `TAKE ${String(i + 1).padStart(2, "0")}`;
      row.innerHTML = `
        <div class="take-top">
          <button type="button" class="mini tk-on" aria-pressed="${tk.on}">${tk.on ? "ON" : "OFF"}</button>
          <span class="take-name">${name}</span>
          <button type="button" class="mini danger tk-del">DELETE</button>
        </div>
        <label class="fader"><span class="tk-sync">SYNC ${tk.nudge > 0 ? "+" : ""}${tk.nudge} MS</span>
          <input type="range" min="-200" max="200" step="5" value="${tk.nudge}" id="sync-${tk.id}">
        </label>`;
      row.querySelector(".tk-on").onclick = () => { tk.on = !tk.on; changed(); };
      const del = row.querySelector(".tk-del");
      let armed = false;
      del.onclick = () => {
        if (!armed) {
          armed = true;
          del.textContent = "SURE?";
          setTimeout(() => { armed = false; del.textContent = "DELETE"; }, 2500);
          return;
        }
        song.takes = song.takes.filter((t) => t !== tk);
        changed();
      };
      const sl = row.querySelector("input");
      sl.oninput = () => {
        tk.nudge = Number(sl.value);
        row.querySelector(".tk-sync").textContent = `SYNC ${tk.nudge > 0 ? "+" : ""}${tk.nudge} MS`;
      };
      sl.onchange = async () => {
        if (song.fx.stutter) await processOne(tk);
        changed({ structure: false });
      };
      return row;
    })
  );
}

// tap vs hold on a pad
function bindHold(el, onTap, onHold) {
  let timer = null;
  let held = false;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    held = false;
    el.classList.add("press");
    timer = setTimeout(() => { held = true; onHold(); }, 450);
  });
  const end = () => {
    el.classList.remove("press");
    if (timer) {
      clearTimeout(timer);
      timer = null;
      if (!held) onTap();
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointerleave", () => { el.classList.remove("press"); clearTimeout(timer); timer = null; });
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---------- keyboard (multi-touch + slide) ----------
const touching = new Map(); // pointerId -> deg
function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.classList.contains("key") ? Number(el.dataset.deg) : null;
}
function press(pid, deg) {
  engine.keyDown(pid, deg);
  touching.set(pid, deg);
  $("keys").children[deg]?.classList.add("down");
  buzz(6);
  if (keysRecArmed && engine.playing) {
    const pos = engine.position();
    const step = Math.round(pos) % LOOP_STEPS;
    if (!song.keysLoop.some((e) => e.step === step && e.deg === deg)) {
      song.keysLoop.push({ step, deg });
      $("keysClear").disabled = false;
      changed({ structure: false });
    }
  }
}
function release(pid) {
  const deg = touching.get(pid);
  if (deg === undefined) return;
  engine.keyUp(pid);
  touching.delete(pid);
  if (![...touching.values()].includes(deg)) $("keys").children[deg]?.classList.remove("down");
}
$("keys").addEventListener("pointerdown", (e) => {
  const deg = keyAt(e.clientX, e.clientY);
  if (deg === null) return;
  e.preventDefault();
  $("keys").setPointerCapture?.(e.pointerId);
  press(e.pointerId, deg);
});
$("keys").addEventListener("pointermove", (e) => {
  if (!touching.has(e.pointerId)) return;
  const deg = keyAt(e.clientX, e.clientY);
  if (deg !== null && deg !== touching.get(e.pointerId)) {
    release(e.pointerId);
    press(e.pointerId, deg);
  }
});
for (const ev of ["pointerup", "pointercancel"]) $("keys").addEventListener(ev, (e) => release(e.pointerId));
$("keys").addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- controls ----------
$("reroll").onclick = () => { reroll(); buzz(12); };
$("octDown").onclick = () => { song.keyOct = Math.max(2, song.keyOct - 1); changed({ structure: false }); toast(`Keys octave ${song.keyOct}`); };
$("octUp").onclick = () => { song.keyOct = Math.min(6, song.keyOct + 1); changed({ structure: false }); toast(`Keys octave ${song.keyOct}`); };
$("keysRec").onclick = async () => {
  keysRecArmed = !keysRecArmed;
  if (keysRecArmed && !engine.playing) { await engine.start(); renderTransport(); }
  render();
};
$("keysClear").onclick = () => { song.keysLoop = []; changed(); };

for (const b of document.querySelectorAll("[data-fx]")) {
  b.onclick = () => {
    const k = b.dataset.fx;
    if (k === "tune") {
      const order = ["hard", "med", "soft", "off"];
      song.fx.tune = order[(order.indexOf(song.fx.tune) + 1) % order.length];
    } else song.fx[k] = !song.fx[k];
    buzz(8);
    changed({ reprocess: true });
  };
}
for (const b of document.querySelectorAll("[data-mute]")) {
  b.onclick = () => { song.mute[b.dataset.mute] = !song.mute[b.dataset.mute]; changed(); };
}

$("play").onclick = async () => {
  if (recording) return;
  if (engine.playing) engine.stop();
  else await engine.start();
  renderTransport();
};
$("rec").onclick = doRecord;
$("export").onclick = () => exportSong(true);
$("bpmChip").onclick = () => showTab("mix");
$("keyChip").onclick = () => showTab("mix");

for (const k of Object.keys(DEFAULT_MIX)) {
  const el = $("m-" + k);
  if (!el) continue;
  el.oninput = () => { song.mix[k] = Number(el.value); changed({ structure: false }); };
}
$("bpm").oninput = () => {
  song.bpm = Number($("bpm").value);
  $("bpmVal").textContent = `${song.bpm} BPM`;
  $("bpmChip").textContent = `${song.bpm} BPM`;
  changed({ structure: false });
};
$("swing").oninput = () => {
  song.swing = Number($("swing").value);
  $("swingVal").textContent = `SWING ${Math.round(song.swing * 100)}%`;
  changed({ structure: false });
};
$("root").innerHTML = NOTE_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join("");
$("root").onchange = () => { song.root = Number($("root").value); changed({ reprocess: true }); };
$("mode").onchange = () => {
  song.mode = $("mode").value;
  // keep progressions playable: swap numerals into the new mode's set where needed
  song.prog = song.prog.map((n) => (SWAP_OPTIONS[song.mode].includes(n) ? n : song.mode === "minor" ? "i" : "I"));
  changed({ reprocess: true });
};
$("lead").onchange = () => { song.lead = $("lead").value; changed({ structure: false }); };
$("songName").oninput = () => { song.name = $("songName").value; changed({ structure: false }); };

$("calibrate").onclick = async () => {
  const b = $("calibrate");
  b.disabled = true;
  b.textContent = "LISTENING...";
  try {
    const lat = await engine.calibrate();
    if (lat === null) {
      toast("Couldn't hear the beeps. Headphones off, volume up, try again.");
    } else {
      lsSet("voxrot.lat", lat.toFixed(4));
      toast(`Sync set: ${Math.round(lat * 1000)} ms. New takes use it.`);
    }
  } catch (e) {
    toast(e && e.name === "NotAllowedError" ? "Mic blocked. Allow the microphone for this site." : "Calibration failed: " + (e.message || e));
  }
  b.disabled = false;
  b.textContent = "CALIBRATE SYNC";
  renderVoxLabel();
};

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const p of ["make", "vox", "mix", "songs"]) $("p-" + p).hidden = p !== name;
  if (name === "songs") renderSongs();
  lsSet("voxrot.tab", name);
}
for (const b of document.querySelectorAll("#tabs button")) b.onclick = () => showTab(b.dataset.tab);

// ---------- engine events ----------
let curStep = -1;
engine.on("step", (st) => {
  curStep = st;
  const steps = $("steps").children;
  for (let i = 0; i < steps.length; i++) steps[i].classList.toggle("on", st >= 0 && i === st % 16);
  const bar = st >= 0 ? Math.floor(st / 16) : -1;
  const pads = $("pads").children;
  for (let i = 0; i < pads.length; i++) pads[i].classList.toggle("now", i === bar);
  if (st >= 0 && st % 16 === 0) glitch(st === 0);
  if (st >= 0) {
    const v = vibeById(song.vibe);
    if (v.drums.kick[st % 16] === "x") kickFlash = 1;
  }
});
engine.on("play", () => renderTransport());
engine.on("count", (n) => {
  const c = $("count");
  if (n > 0) {
    c.hidden = false;
    c.textContent = n;
    c.classList.remove("pop");
    void c.offsetWidth;
    c.classList.add("pop");
    buzz(15);
  } else {
    c.textContent = "SING";
    setTimeout(() => { c.hidden = true; }, 500);
  }
});
let micLevel = 0;
const pitchBuf = new Float32Array(8192);
engine.on("level", (lvl, data) => {
  micLevel = lvl;
  document.documentElement.style.setProperty("--lvl", Math.min(1, lvl * 6).toFixed(3));
  if (!recording || !engine.playing) return;
  pitchBuf.copyWithin(0, data.length);
  pitchBuf.set(data, pitchBuf.length - data.length);
  const tr = detectPitch(pitchBuf, engine.ctx.sampleRate);
  for (let k = tr.f0.length - 1; k >= 0; k--) {
    if (tr.voiced[k]) {
      const pos = engine.position();
      if (pos !== null) livePitch.push({ pos: pos / LOOP_STEPS, midi: 69 + 12 * Math.log2(tr.f0[k] / 440) });
      break;
    }
  }
});

// ---------- visuals ----------
const stat = $("static");
const sctx = stat.getContext("2d", { alpha: true });
const scope = $("scope");
const scx = scope.getContext("2d");
const trace = $("trace");
const tcx = trace.getContext("2d");
let kickFlash = 0;
let tearUntil = 0;
let lastStatic = 0;
let img = null;

function fit(c) {
  const r = c.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return [w, h, dpr];
}
function fitStatic() {
  const w = Math.ceil(innerWidth / 3);
  const h = Math.ceil(innerHeight / 3);
  if (stat.width !== w || stat.height !== h) {
    stat.width = w;
    stat.height = h;
    img = sctx.createImageData(w, h);
  }
}

const tdata = new Float32Array(2048);
function outLevel() {
  if (!engine.analyser) return 0;
  engine.analyser.getFloatTimeDomainData(tdata);
  let s = 0;
  for (let i = 0; i < tdata.length; i += 8) s += tdata[i] * tdata[i];
  return Math.sqrt(s / (tdata.length / 8));
}

function drawStatic(now, level) {
  fitStatic();
  const d = img.data;
  const base = (engine.playing ? 0.16 : 0.1) + Math.min(0.5, level * 1.2) + kickFlash * 0.12 + (recording ? 0.08 : 0);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random() * 255 * base;
    d[i] = v * 0.62;
    d[i + 1] = v;
    d[i + 2] = v * 0.55;
    d[i + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  if (now < tearUntil) {
    for (let k = 0; k < 4; k++) {
      const y = Math.floor(Math.random() * stat.height);
      const h = 2 + Math.floor(Math.random() * 10);
      const dx = Math.floor((Math.random() - 0.5) * 40);
      sctx.drawImage(stat, 0, y, stat.width, h, dx, y, stat.width, h);
    }
  }
}

function drawScope(level) {
  const [w, h, dpr] = fit(scope);
  scx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const has = !!engine.analyser;
  const draw = (color, dx, alpha, lw) => {
    scx.globalAlpha = alpha;
    scx.strokeStyle = color;
    scx.lineWidth = lw * dpr;
    scx.beginPath();
    const N = 256;
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * w + dx * dpr;
      const s = has ? tdata[Math.floor((i / N) * tdata.length)] : 0;
      const jitter = (Math.random() - 0.5) * (has && engine.playing ? 0.02 : 0.06);
      const y = mid + (s * 1.6 + jitter) * mid;
      if (i === 0) scx.moveTo(x, y);
      else scx.lineTo(x, y);
    }
    scx.stroke();
  };
  const phos = getVar("--phos");
  draw(getVar("--blood"), -2 - level * 6, 0.5, 1.5);
  draw(getVar("--ice"), 2 + level * 6, 0.5, 1.5);
  scx.shadowColor = phos;
  scx.shadowBlur = 8 * dpr;
  draw(phos, 0, 1, 2);
  scx.shadowBlur = 0;
  scx.globalAlpha = 1;
}

function drawTrace() {
  const [w, h, dpr] = fit(trace);
  tcx.clearRect(0, 0, w, h);
  const phos = getVar("--phos");
  const dim = getVar("--line");
  // grid: one line per bar
  tcx.strokeStyle = dim;
  tcx.lineWidth = 1;
  for (let b = 1; b < 4; b++) {
    const x = (b / 4) * w;
    tcx.beginPath();
    tcx.moveTo(x, 0);
    tcx.lineTo(x, h);
    tcx.stroke();
  }
  const pcs = scalePitchClasses(song.root, song.mode);
  const pts = [];
  if (recording) {
    for (const p of livePitch) pts.push(p);
  } else {
    const tk = song.takes.find((t) => t.id === lastTakeId) || song.takes[song.takes.length - 1];
    if (tk && tk.track) {
      const tr = tk.track;
      const start = (REC_MARGIN + tk.lat + tk.nudge / 1000) * tk.sr;
      const loopLen = (60 / song.bpm / 4) * LOOP_STEPS * tk.sr;
      for (let k = 0; k < tr.f0.length; k += 2) {
        if (!tr.voiced[k]) continue;
        const n = tr.offset + k * tr.hop;
        const pos = (n - start) / loopLen;
        if (pos < 0 || pos > 1) continue;
        pts.push({ pos, midi: 69 + 12 * Math.log2(tr.f0[k] / 440) });
      }
    }
  }
  if (pts.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) { lo = Math.min(lo, p.midi); hi = Math.max(hi, p.midi); }
    lo -= 2;
    hi += 2;
    if (hi - lo < 10) { const c = (hi + lo) / 2; lo = c - 5; hi = c + 5; }
    const Y = (m) => h - ((m - lo) / (hi - lo)) * h;
    // raw: faint dots
    tcx.fillStyle = getVar("--ghost");
    tcx.globalAlpha = 0.35;
    for (const p of pts) tcx.fillRect(p.pos * w, Y(p.midi), 2 * dpr, 2 * dpr);
    tcx.globalAlpha = 1;
    // snapped: bright steps
    if (song.fx.tune !== "off") {
      tcx.strokeStyle = phos;
      tcx.lineWidth = 2.5 * dpr;
      tcx.shadowColor = phos;
      tcx.shadowBlur = 6 * dpr;
      tcx.beginPath();
      let prev = null;
      for (const p of pts) {
        const s = snapToScale(p.midi, pcs);
        const x = p.pos * w;
        if (prev && x - prev.x < 12 * dpr) {
          tcx.lineTo(x, Y(prev.s));
          tcx.lineTo(x, Y(s));
        } else tcx.moveTo(x, Y(s));
        prev = { x, s };
      }
      tcx.stroke();
      tcx.shadowBlur = 0;
    }
  } else {
    tcx.fillStyle = getVar("--dim");
    tcx.font = `${12 * dpr}px "Space Mono", monospace`;
    tcx.fillText(recording ? "SING..." : "YOUR PITCH SHOWS UP HERE", 10 * dpr, h / 2 + 4 * dpr);
  }
  // playhead
  const pos = engine.position();
  if (pos !== null) {
    const x = (pos / LOOP_STEPS) * w;
    tcx.fillStyle = recording ? getVar("--blood") : phos;
    tcx.fillRect(x, 0, 2 * dpr, h);
  }
}

const varCache = {};
function getVar(n) {
  return (varCache[n] ||= getComputedStyle(document.documentElement).getPropertyValue(n).trim());
}

function glitch(big) {
  if (reduced) return;
  const l = $("logo");
  l.classList.remove("hit", "big");
  void l.offsetWidth;
  l.classList.add("hit");
  if (big) l.classList.add("big");
  tearUntil = performance.now() + (big ? 220 : 110);
}

function frame(now) {
  const level = outLevel();
  if (now - lastStatic > (reduced ? 250 : 40)) {
    drawStatic(now, level);
    lastStatic = now;
  }
  drawScope(level);
  if (!$("p-make").hidden) drawTrace();
  kickFlash *= 0.85;
  document.documentElement.style.setProperty("--kick", kickFlash.toFixed(3));
  requestAnimationFrame(frame);
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- export ----------
async function exportSong(viaShare) {
  toast("Rendering...");
  try {
    const blob = await renderWav(song, 4);
    const name = (song.name || "voxrot").replace(/[^\w-]+/g, "_") + ".wav";
    const file = new File([blob], name, { type: "audio/wav" });
    if (viaShare && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: song.name || "VOXROT" });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("Saved " + name);
  } catch (e) {
    if (e && e.name === "AbortError") return;
    toast("Export failed: " + (e.message || e));
  }
}
$("share").onclick = () => exportSong(true);
$("download").onclick = () => exportSong(false);

// ---------- storage (IndexedDB, this phone only) ----------
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage off */ } }

let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("voxrot", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("songs", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function store(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction("songs", mode);
    const req = fn(tx.objectStore("songs"));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
function serialize(id) {
  const { takes, ...rest } = song;
  return {
    ...JSON.parse(JSON.stringify(rest)),
    id,
    updated: Date.now(),
    takes: takes.map((t) => ({ id: t.id, raw: t.raw, sr: t.sr, lat: t.lat, nudge: t.nudge, on: t.on, seed: t.seed }))
  };
}
async function saveSong(id) {
  try { await store("readwrite", (s) => s.put(serialize(id))); } catch (e) { /* storage unavailable */ }
}
async function loadSong(id) {
  const rec = await store("readonly", (s) => s.get(id));
  if (!rec) return false;
  const base = newSong(rec.vibe);
  song = { ...base, ...rec, id: "current", mix: { ...DEFAULT_MIX, ...rec.mix }, fx: { ...base.fx, ...rec.fx } };
  song.takes = (rec.takes || []).map((t) => ({ ...t, raw: t.raw instanceof Float32Array ? t.raw : new Float32Array(t.raw) }));
  engine.setSong(song);
  render();
  await reprocessAll();
  return true;
}
async function renderSongs() {
  let all = [];
  try { all = await store("readonly", (s) => s.getAll()); } catch (e) { /* none */ }
  const list = (all || []).filter((s) => s.id !== "current").sort((a, b) => b.updated - a.updated);
  const box = $("songs");
  if (!list.length) {
    box.innerHTML = `<p class="empty">Nothing saved yet. Name the song and hit SAVE.</p>`;
    return;
  }
  box.replaceChildren(
    ...list.map((s) => {
      const row = document.createElement("div");
      row.className = "song";
      const d = new Date(s.updated);
      row.innerHTML = `<div class="song-info"><b></b><span class="dimtxt small"></span></div>
        <button type="button" class="mini solid">LOAD</button><button type="button" class="mini danger">DELETE</button>`;
      row.querySelector("b").textContent = s.name || "untitled rot";
      row.querySelector("span").textContent = `${vibeById(s.vibe).name} · ${s.bpm} BPM · ${(s.takes || []).length} takes · ${d.toLocaleDateString()}`;
      const [load, del] = row.querySelectorAll("button");
      load.onclick = async () => {
        engine.stop();
        await loadSong(s.id);
        toast("Loaded " + (s.name || "song"));
        showTab("make");
      };
      let armed = false;
      del.onclick = async () => {
        if (!armed) {
          armed = true;
          del.textContent = "SURE?";
          setTimeout(() => { armed = false; del.textContent = "DELETE"; }, 2500);
          return;
        }
        await store("readwrite", (st) => st.delete(s.id));
        renderSongs();
      };
      return row;
    })
  );
}
$("save").onclick = async () => {
  if (!song.name) {
    song.name = "rot " + new Date().toLocaleDateString();
    $("songName").value = song.name;
  }
  const id = song.savedId || "s" + Date.now().toString(36);
  song.savedId = id;
  await saveSong(id);
  await saveSong("current");
  toast("Saved " + song.name);
  renderSongs();
};
let newArmed = false;
$("newSong").onclick = () => {
  const b = $("newSong");
  if (!newArmed) {
    newArmed = true;
    b.textContent = "SURE? TAP AGAIN";
    setTimeout(() => { newArmed = false; b.textContent = "NEW SONG"; }, 2500);
    return;
  }
  engine.stop();
  song = newSong(song.vibe);
  changed();
  showTab("make");
  toast("Fresh song");
};

// ---------- boot ----------
async function boot() {
  engine.setSong(song);
  render();
  showTab(lsGet("voxrot.tab") || "make");
  try { await loadSong("current"); } catch (e) { /* first run */ }
  requestAnimationFrame(frame);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && engine.playing && !recording) {
    engine.stop();
    renderTransport();
  }
});
boot();

// VOXROT v3 interface
// Screens: TRACKS (overview), PART (drums/bass/chords/melody), VOICE, plus a bottom SHEET.
import { VIBES, SWAP_OPTIONS, NOTE_NAMES, vibeById, parseNumeral, scalePitchClasses, keyLabel } from "./vibes.js";
import { Engine, REC_MARGIN, makeBuffer, renderWav } from "./audio.js";
import { processTake, detectPitch } from "./dsp.js";
import { PARTS, GENE_NAMES, SOUND_GENES, build, freshPart, variations, learn, newTaste, newSeed, chordDegrees } from "./gen.js";

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const COLORS = { drums: "#39ff14", bass: "#00e5ff", chords: "#a57bff", melody: "#ffb020", voice: "#ff2e4d" };
const LABELS = { drums: "DRUMS", bass: "808", chords: "CHORDS", melody: "MELODY", voice: "VOICE" };
const LANES = ["drums", "bass", "chords", "melody", "voice"];
const DEFAULT_MIX = { drums: 0.9, bass: 0.95, chords: 0.7, melody: 0.75, vox: 1, rev: 0.28, dly: 0.16 };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* no haptics */ } };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

let song;
let taste = loadTaste();
let recMode = "voice";
let recording = false;
let melOct = 0;
let curPart = null;
let curBar = 0;
let drift = 0.4;
const varCache = {};
const history = [];
const takeStore = new Map(); // take id -> take (buffers survive undo)

// ---------- song ----------
function extendChords(prog, bars) {
  return Array.from({ length: bars }, (_, i) => prog[i % prog.length]);
}
function newSong(vibeId, bars = 8) {
  const v = vibeById(vibeId);
  const s = {
    v: 3,
    name: "",
    vibe: v.id,
    bpm: v.bpm,
    root: v.root,
    mode: v.mode,
    bars,
    lead: v.lead,
    gen: 0,
    chords: extendChords(pick(v.progressions).split(" "), bars),
    parts: {},
    fx: { ...v.fx },
    mix: { ...DEFAULT_MIX },
    voiceMuted: false,
    takes: []
  };
  for (const p of PARTS) s.parts[p] = freshPart(p, v);
  for (const p of PARTS) build(p, s, v);
  return s;
}
const vibe = () => vibeById(song.vibe);
const BUILD_ORDER = ["drums", "bass", "chords", "melody", "voice"];
const sparse = (v, p) => Math.min(0.35, (v.genes?.[p]?.[0] ?? 0.5) * 0.45);
const isActive = (p) => (p === "voice" ? song.takes.length > 0 : song.parts[p].active !== false);
const nextToAdd = () => BUILD_ORDER.find((p) => !isActive(p));

async function addPart(p) {
  if (p === "voice") {
    recMode = "voice";
    renderTracks();
    return doRecord();
  }
  commit();
  const v = vibe();
  const part = song.parts[p];
  part.active = true;
  part.muted = false;
  part.genes = [...(v.genes?.[p] || part.genes)];
  part.genes[0] = sparse(v, p); // start sparse, build it up with BUSY
  part.seed = newSeed();
  build(p, song, v);
  if (p === "drums" && !song.parts.bass.edited) build("bass", song, v);
  delete varCache[p];
  buzz([8, 30, 8]);
  toast(`${LABELS[p]} in · tap it to shape it`);
  changed();
  if (!engine.playing) { await engine.start(); renderTransport(); }
}
function removePart(p) {
  commit();
  const part = song.parts[p];
  part.active = false;
  part.solo = false;
  part.locked = false;
  delete varCache[p];
  toast(`${LABELS[p]} removed`);
  showScreen("s-tracks");
  changed();
}
function toggleSolo(p) {
  commit();
  if (p === "voice") song.voiceSolo = !song.voiceSolo;
  else song.parts[p].solo = !song.parts[p].solo;
  buzz(12);
  changed();
}

function setVibe(id) {
  commit();
  const v = vibeById(id);
  const hasTakes = song.takes.length > 0;
  song.vibe = v.id;
  song.lead = v.lead;
  song.fx = { ...v.fx };
  if (!hasTakes) {
    song.bpm = v.bpm;
    song.root = v.root;
    song.mode = v.mode;
  }
  if (!song.parts.chords.locked) song.chords = extendChords(pick(v.progressions).split(" "), song.bars);
  for (const p of PARTS) {
    const part = song.parts[p];
    if (part.locked) continue;
    const busy = part.genes[0];
    part.genes = [...(v.genes?.[p] || part.genes)];
    if (part.active) part.genes[0] = busy; // keep how built-up it is
    else part.genes[0] = sparse(v, p);
    part.seed = newSeed();
    build(p, song, v);
  }
  for (const k in varCache) delete varCache[k];
  if (hasTakes) toast(`Kept ${song.bpm} BPM, ${keyLabel(song.root, song.mode)} so your vocals stay in time`);
  changed({ reprocess: true });
}

// ---------- undo ----------
function snapshot() {
  const { takes, ...rest } = song;
  return JSON.stringify({ ...rest, takeIds: takes.map((t) => ({ id: t.id, on: t.on, nudge: t.nudge })) });
}
function commit() {
  history.push(snapshot());
  if (history.length > 60) history.shift();
  $("undo").disabled = false;
}
function undo() {
  const snap = history.pop();
  if (!snap) return;
  const s = JSON.parse(snap);
  const ids = s.takeIds || [];
  delete s.takeIds;
  s.takes = ids.map((t) => {
    const tk = takeStore.get(t.id);
    if (tk) { tk.on = t.on; tk.nudge = t.nudge; }
    return tk;
  }).filter(Boolean);
  song = s;
  for (const k in varCache) delete varCache[k];
  $("undo").disabled = !history.length;
  changed({ reprocess: true, commitSave: true });
  toast("Undone");
}

// ---------- change funnel ----------
let saveTimer = null;
function changed({ reprocess = false } = {}) {
  engine.setSong(song);
  renderTracks();
  if (curPart && !$("s-part").hidden) renderPart();
  if (!$("s-voice").hidden) renderVoice();
  if (reprocess) reprocessAll();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSong("current"), 700);
}
function light() {
  // cheap update during dial drags: audio + visuals only
  engine.setSong(song);
  laneDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSong("current"), 900);
}

// ---------- takes / DSP worker ----------
let worker = null;
const pending = new Map();
try {
  worker = new Worker(new URL("./dsp-worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (p) { pending.delete(e.data.id); p(e.data); }
  };
  worker.onerror = () => { worker = null; };
} catch (e) { worker = null; }
let jobId = 0;
function runDsp(tk, opts) {
  if (!worker) {
    const out = processTake(tk, opts);
    return Promise.resolve({ L: out[0], R: out[1], track: tk.track });
  }
  return new Promise((res) => {
    const id = ++jobId;
    pending.set(id, res);
    worker.postMessage({ id, raw: tk.raw, sr: tk.sr, track: tk.track, opts });
  });
}
function guessLatency() {
  const stored = Number(lsGet("voxrot.lat"));
  if (stored > 0) return stored;
  const c = engine.ctx;
  const g = (c && (c.outputLatency || 0) + (c.baseLatency || 0)) || 0;
  return Math.max(0.06, g + 0.02);
}
async function processOne(tk) {
  const sr = tk.sr;
  const stepLen = (60 / song.bpm / 4) * sr;
  const res = await runDsp(tk, {
    scalePcs: scalePitchClasses(song.root, song.mode),
    ...song.fx,
    gridStart: Math.round((REC_MARGIN + tk.lat + tk.nudge / 1000) * sr),
    stepLen,
    steps: 16 * song.bars,
    seed: tk.seed
  });
  tk.track = res.track;
  tk.buffer = makeBuffer([res.L, res.R], sr);
  // peaks for drawing, over the loop window
  const start = Math.round((REC_MARGIN + tk.lat + tk.nudge / 1000) * sr);
  const len = Math.round(stepLen * 16 * song.bars);
  const N = 256;
  tk.peaks = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0;
    const a = start + Math.floor((i * len) / N);
    const b = start + Math.floor(((i + 1) * len) / N);
    for (let j = a; j < b; j += 8) m = Math.max(m, Math.abs(res.L[j] || 0));
    tk.peaks[i] = m;
  }
}
let reprocessToken = 0;
let processing = 0;
async function reprocessAll() {
  if (!song.takes.length) return;
  const token = ++reprocessToken;
  processing++;
  renderVoiceSub();
  for (const tk of song.takes) {
    if (token !== reprocessToken) break;
    await processOne(tk);
  }
  processing--;
  laneDirty = true;
  renderVoiceSub();
  if (!$("s-voice").hidden) renderTakes();
}

// ---------- recording ----------
let melRec = null;
async function doRecord() {
  if (recording) {
    if (recMode === "voice") engine.cancelRecord();
    else finishMelody(true);
    return;
  }
  if (recMode === "melody") return startMelody();
  try {
    recording = true;
    renderTransport();
    const lat = guessLatency();
    const res = await engine.record(lat);
    recording = false;
    renderTransport();
    if (!res) { toast("Take cancelled"); return; }
    commit();
    const tk = { id: "t" + Date.now().toString(36), raw: res.raw, sr: res.sr, lat, nudge: 0, on: true, seed: Math.floor(Math.random() * 1e9) };
    takeStore.set(tk.id, tk);
    processing++;
    renderVoiceSub();
    await processOne(tk);
    processing--;
    song.takes.push(tk);
    toast(`TAKE ${String(song.takes.length).padStart(2, "0")} IN`);
    buzz([30, 40, 30]);
    changed();
  } catch (e) {
    recording = false;
    renderTransport();
    toast(e && e.name === "NotAllowedError" ? "Mic blocked. Allow the microphone for this site in Chrome settings." : "Couldn't record: " + (e.message || e));
  }
}

async function startMelody() {
  recording = true;
  renderTransport();
  const loopStart = await engine.start(true);
  melRec = { loopStart, notes: [], down: new Map() };
  engine.at(loopStart + engine.loopDur, () => finishMelody(false));
}
function finishMelody(cancel) {
  if (!melRec) return;
  const r = melRec;
  melRec = null;
  recording = false;
  renderTransport();
  if (cancel || !r.notes.length) {
    toast(cancel ? "Melody take cancelled" : "No notes played, melody unchanged");
    return;
  }
  commit();
  const m = song.parts.melody;
  m.notes = r.notes.sort((a, b) => a.step - b.step);
  m.active = true;
  m.edited = true;
  m.locked = true;
  toast(`Melody recorded · ${m.notes.length} notes · locked`);
  changed();
}
function melPos() {
  // where in the loop the player is, compensating for the delay before they hear it
  const c = engine.ctx;
  const out = (c.outputLatency || 0.02) + (c.baseLatency || 0.01);
  return (c.currentTime - out - melRec.loopStart) / engine.stepDur;
}

// ---------- TRACKS screen ----------
function renderTracks() {
  $("v-tempo").textContent = song.bpm;
  $("v-key").textContent = keyLabel(song.root, song.mode);
  $("v-loop").textContent = `${song.bars} BARS`;
  $("v-vibe").textContent = vibe().name.split(" ")[0];
  $("songTitle").textContent = (song.name || "UNTITLED ROT").toUpperCase();
  $("keysLabel").textContent = `KEYS · ${NOTE_NAMES[song.root]} ${song.mode.toUpperCase()}`;
  $("octVal").textContent = `OCT ${melOct > 0 ? "+" : ""}${melOct}`;

  // chord row
  const row = $("chordRow");
  row.innerHTML = `<span></span><div class="cells" style="grid-template-columns:repeat(${song.bars},minmax(0,1fr))"></div>`;
  const cells = row.querySelector(".cells");
  song.chords.forEach((n, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = parseNumeral(n, song.root).name;
    b.setAttribute("aria-label", `Bar ${i + 1} chord ${b.textContent}, tap to change`);
    b.onclick = () => openChordSheet(i);
    cells.appendChild(b);
  });

  // lanes: active parts get a lane + S/M, empty ones a dashed + ADD
  const lanes = $("lanes");
  const nx = nextToAdd();
  const anySolo = PARTS.some((p) => song.parts[p].active && song.parts[p].solo) || song.voiceSolo;
  const n = BUILD_ORDER.filter(isActive).length;
  $("tracksLabel").textContent = `TRACKS · ${n} OF 5${song.gen ? " · GEN " + song.gen : ""}`;
  lanes.replaceChildren(...BUILD_ORDER.map((p) => {
    if (!isActive(p)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "addlane" + (p === nx ? " next" : "");
      b.style.setProperty("--c", COLORS[p]);
      b.innerHTML = p === "voice"
        ? `<span class="lbl"><span class="plus" style="color:${COLORS.voice}">●</span>RECORD VOICE</span>`
        : `<span class="lbl"><span class="plus">+</span>ADD ${LABELS[p]}</span>`;
      if (p === nx) b.insertAdjacentHTML("beforeend", `<span class="nx">NEXT</span>`);
      b.onclick = () => addPart(p);
      return b;
    }
    const row = document.createElement("div");
    row.className = "lanerow";
    const muted = p === "voice" ? song.voiceMuted : song.parts[p].muted;
    const solo = p === "voice" ? song.voiceSolo : song.parts[p].solo;
    const lane = document.createElement("button");
    lane.type = "button";
    lane.className = "lane" + (p !== "voice" && song.parts[p].locked ? " locked" : "") + ((muted || (anySolo && !solo)) ? " dimmed" : "");
    lane.dataset.part = p;
    lane.style.setProperty("--c", COLORS[p]);
    lane.innerHTML = `<span class="meta"><span class="lname">${LABELS[p]}</span><span class="lsub"></span></span><span class="cv"><canvas></canvas></span><span class="flash"></span>`;
    lane.querySelector(".lsub").textContent = laneSub(p);
    lane.setAttribute("aria-label", `${LABELS[p]}. Tap to open.`);
    lane.onclick = () => (p === "voice" ? openVoice() : openPart(p));
    const sm = document.createElement("div");
    sm.className = "sm";
    sm.innerHTML = `<button type="button" class="smb solo" aria-pressed="${!!solo}" aria-label="Solo ${LABELS[p]}">S</button><button type="button" class="smb mute" aria-pressed="${!!muted}" aria-label="Mute ${LABELS[p]}">M</button>`;
    sm.children[0].onclick = () => toggleSolo(p);
    sm.children[1].onclick = () => toggleMute(p);
    row.append(lane, sm);
    return row;
  }));
  laneDirty = true;
  $("keysDock").hidden = recMode !== "melody";
  if (recMode === "melody") renderKeys();
  renderTransport();
}

function laneSub(p) {
  if (p === "voice") {
    const n = song.takes.length;
    if (!n) return "TAP REC TO SING";
    return `${n} TAKE${n > 1 ? "S" : ""} · ${song.fx.tune.toUpperCase()} TUNE`;
  }
  const part = song.parts[p];
  const g = part.genes;
  const word = (x, lo, mid, hi) => (x < 0.33 ? lo : x < 0.66 ? mid : hi);
  if (p === "drums") return `${word(g[0], "SPARSE", "STEADY", "BUSY")} · ${word(g[1], "SOFT", "PUNCHY", "HARD")}`;
  if (p === "bass") return `${vibe().bass.sound.toUpperCase()} · ${word(g[2], "STRAIGHT", "SOME SLIDES", "SLIDES")}`;
  if (p === "chords") return `${part.pattern.style.toUpperCase()} · ${word(g[1], "DARK", "WARM", "BRIGHT")}`;
  return part.edited ? `YOURS · ${part.notes.length} NOTES` : `${part.notes.length} NOTES · ${word(g[0], "SPARSE", "FLOWING", "BUSY")}`;
}

function toggleMute(p) {
  commit();
  if (p === "voice") song.voiceMuted = !song.voiceMuted;
  else song.parts[p].muted = !song.parts[p].muted;
  buzz(12);
  changed();
}

function renderTransport() {
  $("play").classList.toggle("on", engine.playing);
  $("play").setAttribute("aria-label", engine.playing ? "Stop" : "Play");
  const rec = $("rec");
  rec.classList.toggle("on", recording);
  rec.style.setProperty("--rc", recMode === "melody" ? COLORS.melody : COLORS.voice);
  rec.setAttribute("aria-label", recording ? "Stop recording" : recMode === "melody" ? "Record melody" : "Record voice");
  for (const b of $("recMode").children) b.classList.toggle("on", b.dataset.mode === recMode);
  $("undo").disabled = !history.length;
}

// ---------- keys (melody) ----------
function renderKeys() {
  const pcs = scalePitchClasses(song.root, song.mode);
  $("keys").replaceChildren(...Array.from({ length: 8 }, (_, d) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "key" + (d % 7 === 0 ? " root" : "");
    b.dataset.deg = d;
    b.textContent = NOTE_NAMES[pcs[d % 7]];
    b.setAttribute("aria-label", "Play " + b.textContent);
    return b;
  }));
}
const touching = new Map();
function keyAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.classList.contains("key") ? Number(el.dataset.deg) : null;
}
function press(pid, d) {
  const deg = d + melOct * 7;
  engine.noteDown(pid, deg);
  touching.set(pid, d);
  $("keys").children[d]?.classList.add("down");
  buzz(6);
  if (melRec && engine.ctx.currentTime >= melRec.loopStart - engine.stepDur / 2) {
    melRec.down.set(pid, { deg, pos: melPos() });
  }
}
function release(pid) {
  const d = touching.get(pid);
  if (d === undefined) return;
  engine.noteUp(pid);
  touching.delete(pid);
  if (![...touching.values()].includes(d)) $("keys").children[d]?.classList.remove("down");
  const st = melRec && melRec.down.get(pid);
  if (st) {
    melRec.down.delete(pid);
    const n = engine.loopSteps;
    const step = ((Math.round(st.pos) % n) + n) % n;
    const len = Math.max(1, Math.min(8, Math.round(melPos() - st.pos)));
    melRec.notes = melRec.notes.filter((x) => x.step !== step);
    melRec.notes.push({ step, deg: st.deg, len });
  }
}
$("keys").addEventListener("pointerdown", (e) => {
  const d = keyAt(e.clientX, e.clientY);
  if (d === null) return;
  e.preventDefault();
  $("keys").setPointerCapture?.(e.pointerId);
  press(e.pointerId, d);
});
$("keys").addEventListener("pointermove", (e) => {
  if (!touching.has(e.pointerId)) return;
  const d = keyAt(e.clientX, e.clientY);
  if (d !== null && d !== touching.get(e.pointerId)) {
    release(e.pointerId);
    press(e.pointerId, d);
  }
});
for (const ev of ["pointerup", "pointercancel"]) $("keys").addEventListener(ev, (e) => release(e.pointerId));
$("keys").addEventListener("contextmenu", (e) => e.preventDefault());
$("octDn").onclick = () => { melOct = Math.max(-1, melOct - 1); renderTracks(); };
$("octUp").onclick = () => { melOct = Math.min(1, melOct + 1); renderTracks(); };

// ---------- PART screen ----------
function openPart(p) {
  curPart = p;
  curBar = 0;
  showScreen("s-part");
  $("s-part").style.setProperty("--pc", COLORS[p]);
  showPartTab("pattern");
  renderPart();
}
function renderPart() {
  const p = curPart;
  const part = song.parts[p];
  $("partName").textContent = LABELS[p];
  $("partSub").textContent = `${vibe().name} · GEN ${song.gen}${part.edited ? " · HAND EDITED" : ""}`;
  $("partLock").setAttribute("aria-pressed", part.locked);
  $("partSolo").setAttribute("aria-pressed", !!part.solo);
  $("partLock").setAttribute("aria-label", part.locked ? "Unlock part" : "Lock part");
  renderEditor();
  renderDials();
  renderVars();
  renderGenes();
}
function showPartTab(t) {
  for (const b of $("partTabs").children) b.classList.toggle("on", b.dataset.tab === t);
  $("pv-pattern").hidden = t !== "pattern";
  $("pv-sound").hidden = t !== "sound";
}
for (const b of $("partTabs").children) b.onclick = () => showPartTab(b.dataset.tab);
$("partBack").onclick = () => showScreen("s-tracks");
$("partSolo").onclick = () => toggleSolo(curPart);
let removeArmed = false;
$("partRemove").onclick = () => {
  const b = $("partRemove");
  if (!removeArmed) {
    removeArmed = true;
    b.textContent = "TAP AGAIN TO REMOVE";
    setTimeout(() => { removeArmed = false; b.textContent = "REMOVE FROM TRACK"; }, 2500);
    return;
  }
  removeArmed = false;
  b.textContent = "REMOVE FROM TRACK";
  removePart(curPart);
};
$("partLock").onclick = () => {
  const part = song.parts[curPart];
  part.locked = !part.locked;
  toast(part.locked ? `${LABELS[curPart]} locked: vibes and MUTATE skip it` : `${LABELS[curPart]} unlocked`);
  changed();
};

// --- editors ---
function renderEditor() {
  const p = curPart;
  const part = song.parts[p];
  const ed = $("editor");
  ed.innerHTML = "";
  const mkRow = (label, arr, onTap, cls = () => "") => {
    const row = document.createElement("div");
    row.className = "erow";
    row.innerHTML = `<span class="rl">${label}</span>`;
    arr.forEach((v, i) => {
      const c = document.createElement("button");
      c.type = "button";
      c.className = "cell" + (i % 4 === 0 ? " beat" : "") + (v ? " on" : "") + cls(v, i);
      if (v > 1) c.dataset.r = "×" + v;
      c.dataset.i = i;
      c.setAttribute("aria-label", `${label} step ${i + 1} ${v ? "on" : "off"}`);
      c.onclick = () => onTap(i);
      row.appendChild(c);
    });
    ed.appendChild(row);
    return row;
  };
  const edit = (fn) => { commit(); fn(); part.edited = true; light(); renderEditor(); renderTracks(); };
  if (p === "drums") {
    const d = part.pattern;
    mkRow("KICK", d.kick, (i) => edit(() => { d.kick[i] = d.kick[i] ? 0 : 1; })).dataset.row = "kick";
    mkRow("CLAP", d.clap, (i) => edit(() => { d.clap[i] = d.clap[i] ? 0 : 1; })).dataset.row = "clap";
    mkRow("HATS", d.hat, (i) => edit(() => { d.hat[i] = (d.hat[i] + 1) % 5; }), (v) => (v > 1 ? " r" + v : "")).dataset.row = "hat";
    mkRow("OPEN", d.ohat, (i) => edit(() => { d.ohat[i] = d.ohat[i] ? 0 : 1; })).dataset.row = "ohat";
    hintLine(ed, "tap a hat repeatedly for rolls: ×2 ×3 ×4");
  } else if (p === "bass") {
    const d = part.pattern;
    mkRow("HITS", d.rhythm, (i) => edit(() => { d.rhythm[i] = d.rhythm[i] ? 0 : 1; if (!d.rhythm[i]) d.oct[i] = 0; }));
    mkRow("OCT UP", d.oct, (i) => edit(() => { d.oct[i] = d.oct[i] ? 0 : 1; if (d.oct[i]) d.rhythm[i] = 1; }));
    hintLine(ed, "notes follow each bar's chord root");
  } else if (p === "chords") {
    const st = document.createElement("div");
    st.className = "estyle";
    for (const s of ["pad", "stabs", "arp"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s.toUpperCase();
      b.className = part.pattern.style === s ? "on" : "";
      b.onclick = () => edit(() => { part.pattern.style = s; });
      st.appendChild(b);
    }
    ed.appendChild(st);
    mkRow("HITS", part.pattern.rhythm, (i) => edit(() => { part.pattern.rhythm[i] = part.pattern.rhythm[i] ? 0 : 1; }));
    const np = document.createElement("button");
    np.type = "button";
    np.className = "eact";
    np.textContent = "NEW PROGRESSION";
    np.onclick = () => newProgression();
    ed.appendChild(np);
  } else if (p === "melody") {
    renderMelodyEditor(ed, part);
  }
}
function hintLine(parent, text) {
  const h = document.createElement("div");
  h.className = "hint";
  h.style.paddingTop = "4px";
  h.textContent = text;
  parent.appendChild(h);
}

function renderMelodyEditor(ed, part) {
  // bar pager
  const pager = document.createElement("div");
  pager.className = "epager";
  const bars = document.createElement("div");
  bars.className = "bars";
  bars.style.gridTemplateColumns = `repeat(${Math.min(song.bars, 8)},minmax(0,1fr))`;
  const pageStart = Math.floor(curBar / 8) * 8;
  for (let b = pageStart; b < Math.min(song.bars, pageStart + 8); b++) {
    const btn = document.createElement("button");
    btn.type = "button";
    const has = part.notes.some((n) => Math.floor(n.step / 16) === b);
    btn.className = (b === curBar ? "on" : "") + (has ? " has" : "");
    btn.innerHTML = `<span>${parseNumeral(song.chords[b], song.root).name}</span>`;
    btn.setAttribute("aria-label", `Bar ${b + 1}`);
    btn.onclick = () => { curBar = b; renderEditor(); };
    bars.appendChild(btn);
  }
  pager.appendChild(bars);
  if (song.bars > 8) {
    const nx = document.createElement("button");
    nx.type = "button";
    nx.className = "chipbtn";
    nx.textContent = "›";
    nx.setAttribute("aria-label", "Next 8 bars");
    nx.onclick = () => { curBar = (pageStart + 8) % song.bars; renderEditor(); };
    pager.appendChild(nx);
  }
  ed.appendChild(pager);
  // rows: scale degrees, high at top
  const degs = part.notes.map((n) => n.deg);
  const top = Math.max(9, ...degs);
  const bottom = Math.min(0, ...degs);
  const pcs = scalePitchClasses(song.root, song.mode);
  const cd = chordDegrees(song.chords[curBar], song.root, song.mode).map((x) => ((x % 7) + 7) % 7);
  const inBar = part.notes.filter((n) => Math.floor(n.step / 16) === curBar);
  for (let d = top; d >= bottom; d--) {
    const row = document.createElement("div");
    row.className = "erow";
    const pc = pcs[((d % 7) + 7) % 7];
    const ct = cd.includes(((d % 7) + 7) % 7);
    row.innerHTML = `<span class="rl" style="color:${ct ? "var(--fg)" : ""}">${NOTE_NAMES[pc]}${ct ? "•" : ""}</span>`;
    for (let s = 0; s < 16; s++) {
      const step = curBar * 16 + s;
      const start = inBar.find((n) => n.deg === d && n.step === step);
      const tail = !start && inBar.find((n) => n.deg === d && n.step < step && n.step + n.len > step);
      const c = document.createElement("button");
      c.type = "button";
      c.className = "cell" + (s % 4 === 0 ? " beat" : "") + (start ? " on" : tail ? " tail" : "");
      c.dataset.i = s;
      c.setAttribute("aria-label", `${NOTE_NAMES[pc]} step ${s + 1} ${start ? "note" : "empty"}`);
      bindHold(c, () => {
        commit();
        if (start) part.notes = part.notes.filter((n) => n !== start);
        else if (tail) tail.len = step - tail.step;
        else {
          part.notes = part.notes.filter((n) => n.step !== step);
          part.notes.push({ step, deg: d, len: 2 });
          engine.noteDown("ed", d);
          setTimeout(() => engine.noteUp("ed"), 160);
        }
        part.notes.sort((a, b) => a.step - b.step);
        part.edited = true;
        light();
        renderEditor();
        renderTracks();
      }, () => {
        if (!start) return;
        commit();
        start.len = start.len >= 8 ? 1 : start.len * 2;
        part.edited = true;
        light();
        renderEditor();
        buzz(15);
      });
      row.appendChild(c);
    }
    ed.appendChild(row);
  }
  hintLine(ed, "tap: add / remove · hold a note: make it longer · • = chord note");
}

function newProgression() {
  commit();
  const v = vibe();
  const cur = song.chords.slice(0, 4).join(" ");
  const opts = v.progressions.filter((p) => p !== cur);
  let prog = pick(opts.length ? opts : v.progressions).split(" ");
  if (Math.random() < 0.35) prog[Math.floor(Math.random() * prog.length)] = pick(SWAP_OPTIONS[song.mode]);
  song.chords = extendChords(prog, song.bars);
  rebuildFollowers();
  toast("New progression");
  changed({ reprocess: false });
}
function rebuildFollowers() {
  if (!song.parts.melody.edited && !song.parts.melody.locked) build("melody", song, vibe());
}

// --- dials ---
const GEN_GENES = { drums: [0], bass: [0, 3], chords: [0], melody: [0, 1, 2, 3] };
const DIAL_COLORS = ["var(--pc)", "#ff2e4d", "#ffb020", "#00e5ff"];
function renderDials() {
  const p = curPart;
  const part = song.parts[p];
  const box = $("dials");
  box.innerHTML = "";
  GENE_NAMES[p].forEach((name, i) => {
    const d = document.createElement("div");
    d.className = "dial";
    d.style.setProperty("--dc", DIAL_COLORS[i]);
    d.setAttribute("role", "slider");
    d.setAttribute("tabindex", "0");
    d.setAttribute("aria-label", name);
    d.setAttribute("aria-valuemin", "0");
    d.setAttribute("aria-valuemax", "100");
    d.innerHTML = `<svg viewBox="0 0 76 76" aria-hidden="true"><circle class="trk" cx="38" cy="38" r="30" stroke-dasharray="141.4 200" transform="rotate(135 38 38)"/><circle class="val" cx="38" cy="38" r="30" transform="rotate(135 38 38)"/><text x="38" y="43" text-anchor="middle"></text></svg><span class="dn">${name}</span>`;
    const upd = () => {
      const v = part.genes[i];
      d.querySelector(".val").setAttribute("stroke-dasharray", `${(141.4 * v).toFixed(1)} 200`);
      d.querySelector("text").textContent = Math.round(v * 100);
      d.setAttribute("aria-valuenow", Math.round(v * 100));
    };
    upd();
    let sy = 0;
    let sv = 0;
    let raf = 0;
    d.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      d.setPointerCapture(e.pointerId);
      sy = e.clientY;
      sv = part.genes[i];
      commit();
      d.classList.add("drag");
    });
    d.addEventListener("pointermove", (e) => {
      if (!d.classList.contains("drag")) return;
      const v = clamp01(sv + (sy - e.clientY) / 160);
      if (Math.abs(v - part.genes[i]) < 0.004) return;
      part.genes[i] = v;
      upd();
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        setGene(p, i);
      });
    });
    const end = () => {
      if (!d.classList.contains("drag")) return;
      d.classList.remove("drag");
      renderTracks();
      renderVarsMatch();
    };
    d.addEventListener("pointerup", end);
    d.addEventListener("pointercancel", end);
    d.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowUp" || e.key === "ArrowRight" ? 0.05 : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -0.05 : 0;
      if (!step) return;
      e.preventDefault();
      commit();
      part.genes[i] = clamp01(part.genes[i] + step);
      upd();
      setGene(p, i);
      renderTracks();
    });
    box.appendChild(d);
  });
}
function setGene(p, i) {
  const part = song.parts[p];
  if (GEN_GENES[p].includes(i)) {
    build(p, song, vibe());
    if (p === "drums" && !song.parts.bass.locked && !song.parts.bass.edited) build("bass", song, vibe());
    renderEditor();
  }
  light();
  $("partSub").textContent = `${vibe().name} · GEN ${song.gen}`;
  part.edited = false;
}

// --- variations ---
function renderVars() {
  const p = curPart;
  if (!varCache[p]) varCache[p] = variations(p, song, vibe(), taste, { drift }).map((v) => ({ ...v, state: "new" }));
  const box = $("vars");
  box.innerHTML = "";
  varCache[p].forEach((v, idx) => box.appendChild(varCard(p, v, idx)));
}
function renderVarsMatch() { /* scores refresh on next batch */ }
const lastTaps = {};
function varCard(p, v, idx) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "var" + (v.kind === "wild" ? " wild" : "") + (v.state === "kept" ? " kept" : "") + (v.state === "playing" ? " playing" : "");
  el.innerHTML = `<canvas></canvas><span class="vfoot"><span class="vt">${v.state === "kept" ? "KEPT" : v.state === "playing" ? "PLAYING" : v.kind === "wild" ? "WILD" : "NEW"}</span><span class="vm">${taste[p].n ? v.match + "%" : ""}</span></span>`;
  el.setAttribute("aria-label", `Variation ${idx + 1}, ${v.match} percent match. Tap to try, double tap to keep.`);
  requestAnimationFrame(() => drawMini(el.querySelector("canvas"), p, v.part));
  let sx = 0;
  let moved = false;
  el.addEventListener("pointerdown", (e) => { sx = e.clientX; moved = false; });
  el.addEventListener("pointermove", (e) => {
    const dx = e.clientX - sx;
    if (dx < -8) { moved = true; el.style.transform = `translateX(${dx}px)`; el.style.opacity = String(1 + dx / 200); }
  });
  el.addEventListener("pointerup", (e) => {
    const dx = e.clientX - sx;
    el.style.transform = "";
    el.style.opacity = "";
    if (dx < -60) return killVar(p, idx, el);
    if (moved) return;
    const now = performance.now();
    const key = p + idx;
    if (now - (lastTaps[key] || 0) < 350) { lastTaps[key] = 0; keepVar(p, idx); }
    else { lastTaps[key] = now; tryVar(p, idx); }
  });
  el.addEventListener("pointercancel", () => { el.style.transform = ""; el.style.opacity = ""; });
  return el;
}
function applyGenome(p, g) {
  const part = song.parts[p];
  part.genes = [...g.genes];
  part.seed = g.seed;
  if (g.pattern) part.pattern = JSON.parse(JSON.stringify(g.pattern));
  if (g.notes) part.notes = JSON.parse(JSON.stringify(g.notes));
  part.edited = false;
}
function tryVar(p, idx) {
  const v = varCache[p][idx];
  commit();
  applyGenome(p, v.part);
  for (const o of varCache[p]) if (o.state === "playing") o.state = "new";
  if (v.state !== "kept") v.state = "playing";
  buzz(8);
  if (!engine.playing) engine.start().then(renderTransport);
  changed();
}
function keepVar(p, idx) {
  const v = varCache[p][idx];
  learn(taste, p, v.part, song.bars, 1);
  saveTaste();
  v.state = "kept";
  applyGenome(p, v.part);
  buzz([10, 30, 10]);
  toast(`Kept · taste learned from ${taste.count} choices`);
  changed();
}
function killVar(p, idx, el) {
  const v = varCache[p][idx];
  learn(taste, p, v.part, song.bars, -1);
  saveTaste();
  buzz(25);
  el.classList.add("gone");
  setTimeout(() => {
    const fresh = variations(p, song, vibe(), taste, { drift, pool: 20, show: 1 })[0];
    varCache[p][idx] = { ...fresh, state: "new" };
    const card = varCard(p, varCache[p][idx], idx);
    card.classList.add("born");
    el.replaceWith(card);
  }, 180);
}
function drawMini(cv, p, g) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = cv.clientWidth * dpr;
  const h = cv.clientHeight * dpr;
  cv.width = w;
  cv.height = h;
  const x = cv.getContext("2d");
  const col = COLORS[p];
  const cellW = w / 16;
  x.fillStyle = "#161a16";
  for (let i = 0; i < 16; i++) x.fillRect(i * cellW + 1, 0, cellW - 2, h);
  x.fillStyle = col;
  if (p === "drums") {
    g.pattern.kick.forEach((v, i) => v && x.fillRect(i * cellW + 1, h * 0.6, cellW - 2, h * 0.4));
    g.pattern.clap.forEach((v, i) => v && x.fillRect(i * cellW + 1, h * 0.3, cellW - 2, h * 0.25));
    x.globalAlpha = 0.7;
    g.pattern.hat.forEach((v, i) => v && x.fillRect(i * cellW + 1, 0, cellW - 2, h * (0.08 * v + 0.08)));
    x.globalAlpha = 1;
  } else if (p === "bass") {
    g.pattern.rhythm.forEach((v, i) => v && x.fillRect(i * cellW + 1, g.pattern.oct[i] ? 0 : h * 0.45, cellW - 2, h * 0.55));
  } else if (p === "chords") {
    g.pattern.rhythm.forEach((v, i) => v && x.fillRect(i * cellW + 1, h * 0.1, cellW - 2, h * 0.8));
  } else {
    const ns = g.notes.filter((n) => n.step < 32);
    const lo = Math.min(0, ...ns.map((n) => n.deg));
    const hi = Math.max(9, ...ns.map((n) => n.deg));
    const cw = w / 32;
    ns.forEach((n) => x.fillRect(n.step * cw, h - ((n.deg - lo + 1) / (hi - lo + 2)) * h, Math.max(cw, n.len * cw - 1), Math.max(3, h / 10)));
  }
}
$("newBatch").onclick = () => { delete varCache[curPart]; renderVars(); buzz(8); };
$("drift").oninput = () => { drift = Number($("drift").value); };
$("drift").onchange = () => { delete varCache[curPart]; renderVars(); };
$("randomVibe").onclick = () => {
  commit();
  const p = curPart;
  const part = song.parts[p];
  const base = vibe().genes?.[p] || part.genes;
  part.genes = base.map((g) => clamp01(g + (Math.random() - 0.5) * 0.5));
  part.seed = newSeed();
  build(p, song, vibe());
  delete varCache[p];
  buzz(10);
  changed();
};
$("moreLike").onclick = () => {
  delete varCache[curPart];
  varCache[curPart] = variations(curPart, song, vibe(), taste, { drift: drift * 0.5 }).map((v) => ({ ...v, state: "new" }));
  renderVars();
  buzz(8);
  toast("6 close relatives of what's playing");
};

// --- SOUND genes ---
function renderGenes() {
  const p = curPart;
  const part = song.parts[p];
  const box = $("genes");
  box.innerHTML = "";
  SOUND_GENES[p].forEach(([name, , lo, hi], i) => {
    const row = document.createElement("div");
    row.className = "gene";
    row.innerHTML = `<span class="gn">${name}</span><div class="gbar" role="slider" tabindex="0" aria-label="${name}" aria-valuemin="0" aria-valuemax="100"><span class="fill"></span><span class="range" style="left:${lo * 100}%;width:${(hi - lo) * 100}%"></span><span class="gv"></span></div><button type="button" class="glock" aria-pressed="${part.soundLock[i]}" aria-label="Lock ${name}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></button>`;
    const bar = row.querySelector(".gbar");
    const upd = () => {
      row.querySelector(".fill").style.width = part.sound[i] * 100 + "%";
      row.querySelector(".gv").textContent = Math.round(part.sound[i] * 100);
      bar.setAttribute("aria-valuenow", Math.round(part.sound[i] * 100));
    };
    upd();
    const set = (e) => {
      const r = bar.getBoundingClientRect();
      part.sound[i] = clamp01((e.clientX - r.left) / r.width);
      upd();
      light();
    };
    bar.addEventListener("pointerdown", (e) => { e.preventDefault(); bar.setPointerCapture(e.pointerId); commit(); set(e); bar.dataset.drag = "1"; });
    bar.addEventListener("pointermove", (e) => { if (bar.dataset.drag) set(e); });
    bar.addEventListener("pointerup", () => { delete bar.dataset.drag; preview(p); });
    bar.addEventListener("keydown", (e) => {
      const st = e.key === "ArrowRight" ? 0.05 : e.key === "ArrowLeft" ? -0.05 : 0;
      if (!st) return;
      commit();
      part.sound[i] = clamp01(part.sound[i] + st);
      upd();
      light();
    });
    row.querySelector(".glock").onclick = (e) => {
      part.soundLock[i] = !part.soundLock[i];
      e.currentTarget.setAttribute("aria-pressed", part.soundLock[i]);
      light();
    };
    box.appendChild(row);
  });
}
function preview(p) {
  if (engine.playing) return;
  if (p === "melody") { engine.noteDown("pv", 4); setTimeout(() => engine.noteUp("pv"), 300); }
  else engine.auditionChord(0);
}
$("soundRandom").onclick = () => {
  commit();
  const part = song.parts[curPart];
  SOUND_GENES[curPart].forEach(([, , lo, hi], i) => { if (!part.soundLock[i]) part.sound[i] = lo + Math.random() * (hi - lo); });
  renderGenes();
  light();
  preview(curPart);
  buzz(10);
};
$("soundReset").onclick = () => {
  commit();
  const part = song.parts[curPart];
  SOUND_GENES[curPart].forEach(([, def], i) => { if (!part.soundLock[i]) part.sound[i] = def; });
  renderGenes();
  light();
};

// ---------- VOICE screen ----------
function openVoice() {
  showScreen("s-voice");
  renderVoice();
}
function renderVoiceSub() {
  const n = song.takes.length;
  $("voiceSub").textContent = processing ? "PROCESSING…" : n ? `${n} TAKE${n > 1 ? "S" : ""} · SNAPPED TO ${keyLabel(song.root, song.mode)}` : "NO TAKES YET";
  laneDirty = true;
}
function renderVoice() {
  renderVoiceSub();
  $("voiceMute").setAttribute("aria-pressed", song.voiceMuted);
  for (const b of $("fx").children) {
    const k = b.dataset.fx;
    if (k === "tune") {
      b.textContent = "TUNE: " + song.fx.tune.toUpperCase();
      b.classList.toggle("on", song.fx.tune !== "off");
    } else {
      b.classList.toggle("on", !!song.fx[k]);
      b.setAttribute("aria-pressed", !!song.fx[k]);
    }
  }
  $("m-rev").value = song.mix.rev;
  $("m-dly").value = song.mix.dly;
  const lat = lsGet("voxrot.lat");
  $("syncVal").textContent = lat ? `${Math.round(Number(lat) * 1000)} MS MEASURED` : "not calibrated";
  renderTakes();
}
function renderTakes() {
  const box = $("takes");
  if (!song.takes.length) {
    box.innerHTML = `<p class="empty">No takes yet. On TRACKS, pick REC VOICE, hit the red button, wait for the 4 clicks, sing over the loop.</p>`;
    return;
  }
  box.replaceChildren(...song.takes.map((tk, i) => {
    const row = document.createElement("div");
    row.className = "take" + (tk.on ? "" : " off");
    row.innerHTML = `<div class="take-top"><button type="button" class="mini ${tk.on ? "on" : ""}" aria-pressed="${tk.on}">${tk.on ? "ON" : "OFF"}</button><span class="take-name">TAKE ${String(i + 1).padStart(2, "0")}</span><button type="button" class="mini danger">DELETE</button></div><canvas></canvas><label class="fader"><span class="tk-sync">SYNC ${tk.nudge > 0 ? "+" : ""}${tk.nudge} MS</span><input type="range" min="-200" max="200" step="5" value="${tk.nudge}" id="sync-${tk.id}"></label>`;
    const [onBtn, del] = row.querySelectorAll("button");
    onBtn.onclick = () => { commit(); tk.on = !tk.on; changed(); };
    let armed = false;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.textContent = "SURE?";
        setTimeout(() => { armed = false; del.textContent = "DELETE"; }, 2500);
        return;
      }
      commit();
      song.takes = song.takes.filter((t) => t !== tk);
      changed();
    };
    const sl = row.querySelector("input");
    sl.oninput = () => {
      tk.nudge = Number(sl.value);
      row.querySelector(".tk-sync").textContent = `SYNC ${tk.nudge > 0 ? "+" : ""}${tk.nudge} MS`;
    };
    sl.onchange = async () => { await processOne(tk); changed(); };
    requestAnimationFrame(() => drawPeaks(row.querySelector("canvas"), tk.peaks));
    return row;
  }));
}
function drawPeaks(cv, peaks) {
  if (!cv || !peaks) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  const x = cv.getContext("2d");
  x.fillStyle = COLORS.voice;
  const bw = cv.width / peaks.length;
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, peaks[i] * cv.height);
    x.fillRect(i * bw, (cv.height - h) / 2, Math.max(1, bw - 0.5), h);
  }
}
$("voiceBack").onclick = () => showScreen("s-tracks");
$("voiceMute").onclick = () => toggleMute("voice");
for (const b of $("fx").children) {
  b.onclick = () => {
    commit();
    const k = b.dataset.fx;
    if (k === "tune") {
      const order = ["hard", "med", "soft", "off"];
      song.fx.tune = order[(order.indexOf(song.fx.tune) + 1) % order.length];
    } else song.fx[k] = !song.fx[k];
    buzz(8);
    changed({ reprocess: true });
  };
}
$("m-rev").oninput = () => { song.mix.rev = Number($("m-rev").value); light(); };
$("m-dly").oninput = () => { song.mix.dly = Number($("m-dly").value); light(); };
$("calibrate").onclick = async () => {
  const b = $("calibrate");
  b.disabled = true;
  b.textContent = "LISTENING…";
  try {
    const lat = await engine.calibrate();
    if (lat === null) toast("Couldn't hear the beeps. Headphones off, volume up, try again.");
    else {
      lsSet("voxrot.lat", lat.toFixed(4));
      toast(`Sync set: ${Math.round(lat * 1000)} ms. New takes use it.`);
    }
  } catch (e) {
    toast(e && e.name === "NotAllowedError" ? "Mic blocked. Allow the microphone for this site." : "Calibration failed: " + (e.message || e));
  }
  b.disabled = false;
  b.textContent = "CALIBRATE SYNC";
  renderVoice();
};

// ---------- screens ----------
function showScreen(id) {
  const order = ["s-tracks", "s-part", "s-voice"];
  for (const s of order) {
    const el = $(s);
    if (s === id) {
      el.hidden = false;
      el.classList.remove("under");
      if (s !== "s-tracks") {
        el.classList.add("enter");
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("enter")));
      }
    } else if (s === "s-tracks") {
      el.classList.add("under");
    } else el.hidden = true;
  }
  if (id === "s-tracks") { $("s-tracks").classList.remove("under"); curPart = null; renderTracks(); }
}

// ---------- sheet ----------
function openSheet(title, build) {
  $("sheetTitle").textContent = title;
  const body = $("sheetBody");
  body.innerHTML = "";
  build(body);
  $("sheet").hidden = false;
  $("scrim").hidden = false;
}
function closeSheet() {
  $("sheet").hidden = true;
  $("scrim").hidden = true;
}
$("sheetClose").onclick = closeSheet;
$("scrim").onclick = closeSheet;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
function optBtn(label, on, fn, small) {
  const b = el("button", "opt" + (on ? " on" : ""));
  b.type = "button";
  b.innerHTML = label + (small ? `<small>${small}</small>` : "");
  b.onclick = fn;
  return b;
}

$("st-tempo").onclick = () => openSheet("TEMPO", (body) => {
  const locked = song.takes.length > 0;
  const lab = el("div", "label", `<span>${song.bpm} BPM</span><span class="hint">${locked ? "locked: vocals recorded at this tempo" : vibe().name + " sits around " + vibe().bpm}</span>`);
  const r = el("input");
  r.type = "range"; r.min = 70; r.max = 210; r.step = 1; r.value = song.bpm; r.disabled = locked; r.setAttribute("aria-label", "Tempo");
  r.onpointerdown = () => commit();
  r.oninput = () => { song.bpm = Number(r.value); lab.firstChild.textContent = `${song.bpm} BPM`; $("v-tempo").textContent = song.bpm; light(); };
  r.onchange = () => changed();
  body.append(lab, r);
  const g = el("div", "grid4");
  for (const d of [-10, -1, 1, 10]) g.appendChild(optBtn(d > 0 ? `+${d}` : `${d}`, false, () => { if (locked) return; commit(); song.bpm = Math.max(70, Math.min(210, song.bpm + d)); r.value = song.bpm; lab.firstChild.textContent = `${song.bpm} BPM`; changed(); }));
  body.appendChild(g);
});
$("st-key").onclick = () => openSheet("KEY", (body) => {
  const g = el("div", "grid4");
  NOTE_NAMES.forEach((n, i) => g.appendChild(optBtn(n, i === song.root, () => { commit(); song.root = i; changed({ reprocess: true }); closeSheet(); })));
  const m = el("div", "grid3");
  m.style.gridTemplateColumns = "repeat(2,minmax(0,1fr))";
  for (const mode of ["minor", "major"]) m.appendChild(optBtn(mode.toUpperCase(), song.mode === mode, () => {
    commit();
    song.mode = mode;
    song.chords = song.chords.map((n) => (SWAP_OPTIONS[mode].includes(n) ? n : mode === "minor" ? "i" : "I"));
    rebuildFollowers();
    changed({ reprocess: true });
    closeSheet();
  }, mode === "minor" ? "dark, most of these vibes" : "brighter, digi / glitter"));
  body.append(g, m, el("p", "hint block", song.takes.length ? "Your takes re-snap to the new key." : "Chords and melody move with the key."));
});
$("st-loop").onclick = () => openSheet("LOOP LENGTH", (body) => {
  const locked = song.takes.length > 0;
  const g = el("div", "grid3");
  for (const n of [4, 8, 16]) g.appendChild(optBtn(`${n} BARS`, song.bars === n, () => {
    if (locked) return;
    commit();
    const old = song.bars;
    song.bars = n;
    song.chords = extendChords(song.chords.slice(0, old), n);
    const m = song.parts.melody;
    if (m.edited || m.locked) {
      const steps = old * 16;
      const out = [];
      for (let off = 0; off < n * 16; off += steps) for (const x of m.notes) if (x.step + off < n * 16) out.push({ ...x, step: x.step + off });
      m.notes = out;
    } else build("melody", song, vibe());
    changed();
    closeSheet();
  }, `${Math.round((n * 4 * 60) / song.bpm)} s`));
  body.append(g, el("p", "hint block", locked ? "Locked: your vocal takes are this long. Delete them to change length." : "Longer loops repeat the progression and write a longer melody."));
});
$("st-vibe").onclick = () => openSheet("VIBE", (body) => {
  const list = el("div", "vibelist");
  for (const vb of VIBES) list.appendChild(optBtn(vb.name, vb.id === song.vibe, () => { setVibe(vb.id); buzz(10); closeSheet(); }, `${vb.bpm} BPM · ${keyLabel(vb.root, vb.mode)}`));
  body.append(list, el("p", "hint block", "Restyles the parts you've added, keeps how built-up they are. Locked parts stay as they are."));
});
const openTasteSheet = () => openSheet("YOUR TASTE", (body) => {
  body.appendChild(el("p", "hint block", `Learned from <b style="color:var(--cyan)">${taste.count}</b> keeps and kills. Variations are ranked by it; one WILD card per batch ignores it so you don't get stuck in a rut.`));
  for (const p of PARTS) {
    const m = taste[p];
    const strength = Math.min(1, m.w.reduce((a, w) => a + Math.abs(w), 0) / 6);
    body.appendChild(el("div", "tastebar", `<span>${LABELS[p]}</span><i><b style="width:${Math.round(strength * 100)}%"></b></i>`));
  }
  let armed = false;
  const reset = optBtn("RESET TASTE", false, () => {
    if (!armed) { armed = true; reset.innerHTML = "TAP AGAIN TO FORGET"; return; }
    taste = newTaste();
    saveTaste();
    for (const k in varCache) delete varCache[k];
    renderTracks();
    closeSheet();
    toast("Taste forgotten");
  });
  body.appendChild(reset);
});

function openChordSheet(bar) {
  openSheet(`BAR ${bar + 1} CHORD`, (body) => {
    const g = el("div", "grid4");
    const opts = [...new Set([song.chords[bar], ...SWAP_OPTIONS[song.mode]])];
    for (const n of opts) {
      const c = parseNumeral(n, song.root);
      g.appendChild(optBtn(c.name, n === song.chords[bar], () => {
        commit();
        song.chords[bar] = n;
        rebuildFollowers();
        changed();
        engine.auditionChord(bar);
        closeSheet();
      }, n));
    }
    body.appendChild(g);
    body.appendChild(optBtn("NEW PROGRESSION FOR ALL BARS", false, () => { newProgression(); closeSheet(); }));
  });
}

$("menuBtn").onclick = () => openSheet("SONG", async (body) => {
  const name = el("input", "text");
  name.type = "text"; name.maxLength = 40; name.placeholder = "untitled rot"; name.value = song.name || ""; name.id = "songName"; name.setAttribute("aria-label", "Song name");
  name.oninput = () => { song.name = name.value; $("songTitle").textContent = (song.name || "UNTITLED ROT").toUpperCase(); light(); };
  const r1 = el("div", "grid3");
  r1.append(
    optBtn("SAVE", false, async () => {
      if (!song.name) { song.name = "rot " + new Date().toLocaleDateString(); name.value = song.name; }
      song.savedId ||= "s" + Date.now().toString(36);
      await saveSong(song.savedId);
      await saveSong("current");
      toast("Saved " + song.name);
      closeSheet();
    }),
    optBtn("SHARE", false, () => { closeSheet(); exportSong(true); }),
    optBtn("WAV", false, () => { closeSheet(); exportSong(false); })
  );
  let armed = false;
  const fresh = optBtn("NEW SONG", false, () => {
    if (!armed) { armed = true; fresh.innerHTML = "TAP AGAIN: START FRESH"; return; }
    engine.stop();
    history.length = 0;
    song = newSong(song.vibe, song.bars);
    for (const k in varCache) delete varCache[k];
    changed();
    closeSheet();
    toast("Fresh song");
  });
  body.append(name, r1, fresh, optBtn(`YOUR TASTE · ${taste.count} CHOICES`, false, () => openTasteSheet()));
  body.appendChild(el("div", "label", "<span>LEVELS</span>"));
  for (const [k, lab] of [["drums", "DRUMS"], ["bass", "808"], ["chords", "CHORDS"], ["melody", "MELODY"], ["vox", "VOICE"]]) {
    const f = el("label", "fader", `<span>${lab}</span>`);
    const r = el("input");
    r.type = "range"; r.min = 0; r.max = k === "vox" ? 2 : 1.5; r.step = 0.01; r.value = song.mix[k]; r.setAttribute("aria-label", lab + " level");
    r.oninput = () => { song.mix[k] = Number(r.value); light(); };
    f.appendChild(r);
    body.appendChild(f);
  }
  body.appendChild(el("div", "label", "<span>SAVED ON THIS PHONE</span>"));
  let all = [];
  try { all = await store("readonly", (s) => s.getAll()); } catch (e) { /* none */ }
  const list = (all || []).filter((s) => s.id !== "current" && s.v === 3).sort((a, b) => b.updated - a.updated);
  if (!list.length) body.appendChild(el("p", "empty", "Nothing saved yet. Name it and hit SAVE."));
  for (const s of list) {
    const row = el("div", "songrow", `<div class="si"><b></b><span></span></div>`);
    row.querySelector("b").textContent = s.name || "untitled rot";
    row.querySelector("span").textContent = `${vibeById(s.vibe).name} · ${s.bpm} BPM · ${s.bars} BARS · ${(s.takes || []).length} TAKES`;
    const load = el("button", "mini solid", "LOAD");
    load.type = "button";
    load.onclick = async () => { engine.stop(); await loadSong(s.id); closeSheet(); toast("Loaded " + (s.name || "song")); };
    const del = el("button", "mini danger", "DELETE");
    del.type = "button";
    let a2 = false;
    del.onclick = async () => {
      if (!a2) { a2 = true; del.textContent = "SURE?"; return; }
      await store("readwrite", (st) => st.delete(s.id));
      row.remove();
    };
    row.append(load, del);
    body.appendChild(row);
  }
});

// ---------- transport ----------
$("play").onclick = async () => {
  if (recording) return;
  if (engine.playing) engine.stop();
  else await engine.start();
  renderTransport();
};
$("rec").onclick = doRecord;
$("undo").onclick = undo;
$("export").onclick = () => exportSong(true);
$("mutate").onclick = () => {
  commit();
  song.gen++;
  let n = 0;
  for (const p of PARTS) {
    if (song.parts[p].locked || !song.parts[p].active) continue;
    const best = variations(p, song, vibe(), taste, { drift, pool: 20, show: 1 })[0];
    applyGenome(p, best.part);
    n++;
    const lane = $("lanes").querySelector(`[data-part="${p}"]`);
    if (lane && !reduced) { lane.classList.remove("mutating"); void lane.offsetWidth; lane.classList.add("mutating"); }
  }
  for (const k in varCache) delete varCache[k];
  buzz([10, 20, 10, 20, 10]);
  toast(n ? `Generation ${song.gen} · ${n} part${n > 1 ? "s" : ""} evolved` : "Nothing to evolve: add a part or unlock one");
  changed();
};
for (const b of $("recMode").children) {
  b.onclick = () => {
    if (recording) return;
    recMode = b.dataset.mode;
    renderTracks();
  };
}

// tap vs hold
function bindHold(node, onTap, onHold) {
  let timer = null;
  let held = false;
  let sx = 0;
  let sy = 0;
  node.addEventListener("pointerdown", (e) => {
    held = false;
    sx = e.clientX;
    sy = e.clientY;
    timer = setTimeout(() => { held = true; timer = null; onHold(); }, 450);
  });
  node.addEventListener("pointermove", (e) => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(timer); timer = null; }
  });
  node.addEventListener("pointerup", () => {
    if (timer) { clearTimeout(timer); timer = null; if (!held) onTap(); }
  });
  node.addEventListener("pointercancel", () => { clearTimeout(timer); timer = null; });
  node.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---------- engine events ----------
engine.on("play", renderTransport);
engine.on("step", (st, hits) => {
  curStep = st;
  if (st < 0) return;
  for (const h of hits) {
    flashLane(h.part);
    if (h.part === "drums" && h.row === "kick") {
      $("led").classList.add("hit");
      setTimeout(() => $("led").classList.remove("hit"), 70);
    }
  }
  // chord row "now" marker
  const bar = Math.floor(st / 16);
  const cells = $("chordRow").querySelector(".cells");
  if (cells) for (let i = 0; i < cells.children.length; i++) cells.children[i].classList.toggle("now", i === bar);
  // part editor: current column + pings
  if (curPart && !$("s-part").hidden) {
    const ed = $("editor");
    const s = st % 16;
    const show = curPart !== "melody" || bar === curBar;
    for (const row of ed.querySelectorAll(".erow")) {
      const cs = row.querySelectorAll(".cell");
      cs.forEach((c, i) => c.classList.toggle("now", show && i === s));
      if (show && hits.some((h) => h.part === curPart && (!h.row || h.row === row.dataset.row))) {
        const c = cs[s];
        if (c && c.classList.contains("on")) {
          c.classList.add("ping");
          setTimeout(() => c.classList.remove("ping"), 90);
        }
      }
    }
  }
});
engine.on("count", (n) => {
  const c = $("count");
  if (n > 0) {
    c.hidden = false;
    c.textContent = n;
    c.style.color = recMode === "melody" ? COLORS.melody : "";
    c.classList.remove("pop");
    void c.offsetWidth;
    c.classList.add("pop");
    buzz(15);
  } else {
    c.textContent = recMode === "melody" ? "PLAY" : "SING";
    setTimeout(() => { c.hidden = true; }, 450);
  }
});
let levelTick = 0;
engine.on("level", (lvl) => {
  if ((levelTick = (levelTick + 1) % 2)) return;
  document.documentElement.style.setProperty("--lvl", Math.min(1, lvl * 6).toFixed(3));
});
const flashTimers = {};
function flashLane(p) {
  const lane = $("lanes").querySelector(`[data-part="${p}"]`);
  if (!lane || $("s-tracks").classList.contains("under")) return;
  lane.classList.add("hit");
  clearTimeout(flashTimers[p]);
  flashTimers[p] = setTimeout(() => lane.classList.remove("hit"), 60);
}

// ---------- drawing ----------
let laneDirty = true;
let curStep = -1;
const laneCache = {};
function drawLaneStatic(p, w, h) {
  const off = laneCache[p] || (laneCache[p] = document.createElement("canvas"));
  off.width = w;
  off.height = h;
  const x = off.getContext("2d");
  const bars = song.bars;
  const bw = w / bars;
  const col = COLORS[p];
  const pad = 2;
  for (let b = 0; b < bars; b++) {
    x.fillStyle = "#0f120f";
    x.fillRect(b * bw + pad / 2, 0, bw - pad, h);
  }
  x.fillStyle = col;
  const sw = bw / 16;
  if (p === "drums") {
    const d = song.parts.drums.pattern;
    for (let b = 0; b < bars; b++) for (let s = 0; s < 16; s++) {
      const X = b * bw + s * sw + 1;
      if (d.kick[s]) x.fillRect(X, h * 0.62, Math.max(1, sw - 1.5), h * 0.32);
      if (d.clap[s]) x.fillRect(X, h * 0.3, Math.max(1, sw - 1.5), h * 0.26);
      if (d.hat[s]) { x.globalAlpha = 0.65; x.fillRect(X, h * 0.06, Math.max(1, sw - 1.5), h * (0.08 + d.hat[s] * 0.035)); x.globalAlpha = 1; }
    }
  } else if (p === "bass") {
    const d = song.parts.bass.pattern;
    for (let b = 0; b < bars; b++) for (let s = 0; s < 16; s++) {
      if (!d.rhythm[s]) continue;
      let len = 1;
      while (s + len < 16 && !d.rhythm[s + len]) len++;
      x.fillRect(b * bw + s * sw + 1, d.oct[s] ? h * 0.2 : h * 0.55, len * sw - 2, h * 0.24);
    }
  } else if (p === "chords") {
    const d = song.parts.chords.pattern;
    for (let b = 0; b < bars; b++) for (let s = 0; s < 16; s++) {
      if (!d.rhythm[s]) continue;
      let len = 1;
      while (s + len < 16 && !d.rhythm[s + len]) len++;
      const L = d.style === "stabs" ? Math.min(len, 2) : d.style === "arp" ? 1 : len;
      x.globalAlpha = 0.8;
      for (let k = 0; k < 3; k++) x.fillRect(b * bw + s * sw + 1, h * (0.14 + k * 0.26), L * sw - 2, h * 0.18);
      x.globalAlpha = 1;
    }
  } else if (p === "melody") {
    const ns = song.parts.melody.notes;
    const lo = Math.min(0, ...ns.map((n) => n.deg));
    const hi = Math.max(9, ...ns.map((n) => n.deg));
    for (const n of ns) {
      const y = h - ((n.deg - lo + 1) / (hi - lo + 2)) * h;
      x.fillRect(n.step * sw + 1, y - 2, Math.max(2, n.len * sw - 2), 5);
    }
  } else if (p === "voice") {
    const tks = song.takes.filter((t) => t.on && t.peaks);
    if (!tks.length) {
      x.fillStyle = "#3a1218";
      x.font = `${Math.round(h * 0.2)}px "JetBrains Mono", monospace`;
      x.fillText("· · ·", 8, h * 0.6);
    } else {
      const N = 256;
      for (let i = 0; i < N; i++) {
        let m = 0;
        for (const t of tks) m = Math.max(m, t.peaks[i]);
        const hh = Math.max(1, m * h * 0.9);
        x.fillRect((i / N) * w, (h - hh) / 2, Math.max(1, w / N - 0.6), hh);
      }
    }
  }
  return off;
}
function drawLanes() {
  const lanes = $("lanes").querySelectorAll(".lane");
  const pos = engine.position();
  const steps = 16 * song.bars;
  for (const lane of lanes) {
    const cv = lane.querySelector("canvas");
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(cv.clientWidth * dpr);
    const h = Math.round(cv.clientHeight * dpr);
    if (!w || !h) continue;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; laneDirty = true; }
    const p = lane.dataset.part;
    if (laneDirty || !laneCache[p] || laneCache[p].width !== w) drawLaneStatic(p, w, h);
    const x = cv.getContext("2d");
    x.clearRect(0, 0, w, h);
    x.drawImage(laneCache[p], 0, 0);
    if (pos !== null) {
      const px = (pos / steps) * w;
      x.fillStyle = "rgba(255,255,255,0.08)";
      x.fillRect(px - 14 * dpr, 0, 14 * dpr, h);
      x.fillStyle = "#fff";
      x.fillRect(px, 0, 2 * dpr, h);
    }
  }
  laneDirty = false;
}
const tdata = new Float32Array(1024);
function drawScope() {
  const cv = $("scope");
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.round(cv.clientWidth * dpr);
  const h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const x = cv.getContext("2d");
  x.clearRect(0, 0, w, h);
  if (engine.analyser) engine.analyser.getFloatTimeDomainData(tdata);
  else tdata.fill(0);
  x.strokeStyle = "#1c1f1c";
  x.lineWidth = 1;
  x.beginPath();
  x.moveTo(0, h / 2);
  x.lineTo(w, h / 2);
  x.stroke();
  const line = (color, width, alpha) => {
    x.strokeStyle = color;
    x.globalAlpha = alpha;
    x.lineWidth = width * dpr;
    x.beginPath();
    for (let i = 0; i < 200; i++) {
      const v = tdata[Math.floor((i / 200) * tdata.length)];
      const X = (i / 199) * w;
      const Y = h / 2 + v * h * 0.9;
      if (i) x.lineTo(X, Y);
      else x.moveTo(X, Y);
    }
    x.stroke();
  };
  line(recording ? COLORS.voice : "#f2f5f2", 5, 0.12);
  line(recording ? COLORS.voice : "#f2f5f2", 1.5, 0.9);
  x.globalAlpha = 1;
}
function frame() {
  if (!$("s-tracks").classList.contains("under")) {
    drawScope();
    drawLanes();
  }
  requestAnimationFrame(frame);
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

// ---------- export ----------
async function exportSong(viaShare) {
  toast("Rendering…");
  try {
    const blob = await renderWav(song, song.bars >= 8 ? 2 : 4);
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

// ---------- storage ----------
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage off */ } }
function loadTaste() {
  try {
    const t = JSON.parse(lsGet("voxrot.taste"));
    if (t && t.drums) return t;
  } catch (e) { /* fresh */ }
  return newTaste();
}
function saveTaste() { lsSet("voxrot.taste", JSON.stringify(taste)); }

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
  if (!rec || rec.v !== 3) return false;
  const { id: _id, updated, ...rest } = rec;
  song = { ...newSong(rec.vibe, rec.bars), ...rest, mix: { ...DEFAULT_MIX, ...rec.mix } };
  for (const p of PARTS) {
    if (song.parts[p].active === undefined) song.parts[p].active = true; // songs saved before v3.1
    song.parts[p].solo ||= false;
  }
  song.takes = (rec.takes || []).map((t) => {
    const tk = { ...t, raw: t.raw instanceof Float32Array ? t.raw : new Float32Array(t.raw) };
    takeStore.set(tk.id, tk);
    return tk;
  });
  history.length = 0;
  for (const k in varCache) delete varCache[k];
  changed();
  await reprocessAll();
  return true;
}

// ---------- boot ----------
async function boot() {
  song = newSong(pick(VIBES).id);
  engine.setSong(song);
  renderTracks();
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

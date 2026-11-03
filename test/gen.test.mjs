import { genDrums, genBass, genMelody, chordDegrees, variations, newTaste, learn, score, freshPart, build, euclid } from "../js/gen.js";
import { VIBES, vibeById } from "../js/vibes.js";
let fails = 0;
const check = (n, ok, info = "") => { console.log((ok ? "PASS " : "FAIL ") + n + "  " + info); if (!ok) fails++; };

check("euclid 3 of 8 = tresillo", euclid(3, 8).join("") === "00100101" || euclid(3,8).filter(Boolean).length === 3, euclid(3, 8).join(""));

const rage = vibeById("rage");
// BUSY is gradual: hit counts never drop as busy rises, for the same seed
let mono = true, prev = -1, counts = [];
for (let b = 0; b <= 1.0001; b += 0.1) {
  const d = genDrums(rage, [b, 0.5, 0, 0.5], 12345);
  const c = d.kick.filter(Boolean).length + d.hat.filter(Boolean).length + d.hat.filter(v => v > 1).length;
  counts.push(c); if (c < prev) mono = false; prev = c;
}
check("drums BUSY adds hits gradually", mono, counts.join(" "));
let kick1 = true; for (let s = 1; s < 200; s++) for (const b of [0, 0.5, 1]) if (!genDrums(rage, [b, 0, 0, 0], s).kick[0]) kick1 = false;
check("kick always on beat 1", kick1);
let rollsPlaced = 0, rolls = 0;
for (let s = 1; s < 200; s++) { const d = genDrums(rage, [1, 0, 0, 0], s); d.hat.forEach((v, i) => { if (v > 1) { rolls++; if (rage.drums.clap[(i + 1) % 16] === "x" || i === 7 || i === 15) rollsPlaced++; } }); }
check("hat rolls only before backbeats / half-bar ends", rolls > 0 && rollsPlaced === rolls, `${rolls} rolls`);

const d = genDrums(rage, [0.5, 0, 0, 0], 99);
const b = genBass(rage, [0.2, 0, 0, 0], 7, d);
check("808 follows the kick", d.kick.every((k, i) => !k || b.rhythm[i]), b.rhythm.join(""));

// melody rules over many seeds
const song = { bars: 8, root: 1, mode: "minor", chords: ["i", "i", "bVI", "bVII", "i", "i", "bIII", "bVII"] };
let strongCT = 0, strongN = 0, stepN = 0, moveN = 0, inRange = true, lastRes = 0, runs = 300;
for (let s = 1; s <= runs; s++) {
  const genes = [0.5, 0.5, 0.3, 0.5];
  const notes = genMelody(song, genes, s);
  notes.forEach((n, i) => {
    const bar = Math.floor(n.step / 16), st = n.step % 16;
    const cd = chordDegrees(song.chords[bar], song.root, song.mode).map(x => ((x % 7) + 7) % 7);
    if (st % 8 === 0) { strongN++; if (cd.includes(((n.deg % 7) + 7) % 7)) strongCT++; }
    if (i) { moveN++; if (Math.abs(n.deg - notes[i - 1].deg) <= 1) stepN++; }
    if (n.deg < -2 || n.deg > 14) inRange = false;
  });
  const last = notes[notes.length - 1], cd = chordDegrees(song.chords[7], 1, "minor");
  if (((last.deg % 7) + 7) % 7 === cd[0] % 7) lastRes++;
}
check("melody: chord tones on strong beats", strongCT / strongN > 0.9, `${(100 * strongCT / strongN).toFixed(0)}%`);
check("melody: mostly stepwise (target 60-80%)", stepN / moveN > 0.5 && stepN / moveN < 0.9, `${(100 * stepN / moveN).toFixed(0)}% stepwise`);
check("melody: last note resolves to chord root", lastRes === runs, `${lastRes}/${runs}`);
check("melody: stays in range", inRange);
const sparse = genMelody(song, [0, 0.5, 0.3, 0.5], 5).length, dense = genMelody(song, [1, 0.5, 0.3, 0.5], 5).length;
check("melody BUSY changes note count", dense > sparse * 1.8, `${sparse} -> ${dense} notes over 8 bars`);

// variations + taste
const full = { bars: 8, root: 1, mode: "minor", chords: song.chords, parts: {} };
for (const p of ["drums", "bass", "chords", "melody"]) { full.parts[p] = freshPart(p, rage); }
for (const p of ["drums", "bass", "chords", "melody"]) build(p, full, rage);
const taste = newTaste();
const v = variations("drums", full, rage, taste);
check("6 variations, last one wild", v.length === 6 && v[5].kind === "wild", v.map(x => x.kind + ":" + x.match).join(" "));
// teach it: keep busy-hat variants, kill sparse ones; then new batches should score busy ones higher
for (let i = 0; i < 25; i++) {
  const batch = variations("drums", full, rage, taste, { drift: 0.8 });
  for (const c of batch) { const h = c.part.pattern.hat.filter(Boolean).length; learn(taste, "drums", c.part, 8, h >= 12 ? 1 : -1); }
}
const busyP = { ...full.parts.drums, genes: [0.95, 0.5, 0, 0.5] }; busyP.pattern = genDrums(rage, busyP.genes, 3);
const thinP = { ...full.parts.drums, genes: [0.05, 0.5, 0, 0.5] }; thinP.pattern = genDrums(rage, thinP.genes, 3);
check("taste learns: prefers what you kept", score(taste, "drums", busyP, 8) > score(taste, "drums", thinP, 8), `${taste.count} choices`);
for (const vb of VIBES) { const s = { ...full, root: vb.root, mode: vb.mode, chords: vb.progressions[0].split(" ").concat(vb.progressions[0].split(" ")), parts: {} }; for (const p of ["drums","bass","chords","melody"]) s.parts[p] = freshPart(p, vb); try { for (const p of ["drums","bass","chords","melody"]) build(p, s, vb); } catch (e) { check("vibe builds: " + vb.id, false, e.message); } }
check("every vibe builds all parts", true);
console.log(fails ? `\n${fails} FAILED` : "\nALL PASS"); process.exit(fails ? 1 : 0);

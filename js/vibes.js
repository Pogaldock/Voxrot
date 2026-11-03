// VOXROT vibes + music theory
// ------------------------------------------------------------
// Every vibe is plain data. Edit freely.
//
// Drum / bass / chord patterns are 16 characters = one bar of 16th notes.
//   "x" = hit, "." = rest.   "x...x...x...x..." = four on the floor.
//
// Chord progressions are roman numerals relative to the key:
//   UPPERCASE = major chord, lowercase = minor chord, "°" = diminished
//   "b" prefix = flat degree (bVI in A minor = F major)
//   "7" suffix = adds a flat seventh, "maj7" suffix = adds a major seventh
//   Example in F# minor: "i bVI bIII bVII" = F#m  D  A  E
//
// chords.style:  "pad"   = hold the chord for the whole bar
//                "stabs" = hit the chord on every "x" of chords.pattern
//                "arp"   = play the chord's notes one by one on every "x"
// chords.sound:  "saw" (bright supersaw) | "pluck" (guitar-ish) | "square" (chip)
// bass.sound:    "808" (sine boom) | "reese" (wobbly saw) | "square"
// lead:          what the keyboard plays: "saw" | "pluck" | "square"
// ------------------------------------------------------------

// genes: starting positions of each part's 4 dials (see gen.js GENE_NAMES)
// swing: 0 = straight, 0.15 = every second 16th pushed late (UK garage / bassline feel)
// bass.glide: 808 slides into the next note (rage)
// Sources for each preset's choices are noted next to it.

export const VIBES = [
  {
    // krushclub: bouncy Jersey club kick, bitcrushed synths and vocals, very short songs
    id: "crush",
    genes: { drums: [0.6, 0.8, 0, 0.6], bass: [0.4, 0.75, 0.2, 0.3], chords: [0.3, 0.9, 0.6, 0.9], melody: [0.5, 0.5, 0.4, 0.6] },
    name: "CRUSH CLUB",
    bpm: 150,
    swing: 0,
    root: 6, // F#
    mode: "minor",
    progressions: ["i bVI bIII bVII", "i bVII bVI bVII", "bVI bVII i i", "i bIII bVII bVI", "bVImaj7 bVII i v"],
    drums: {
      kick:  "x...x...x.x.x...", // Jersey club bounce: boom boom ba-ba-ba
      clap:  "....x.......x...",
      hat:   "x.xxx.xxx.xxx.xx",
      ohat:  "..............x.",
      drive: 0.7
    },
    bass: { sound: "808", pattern: "x...x...x.x.x...", drive: 0.7, octave: 1, glide: false },
    chords: { style: "pad", sound: "saw", pattern: "x...............", bright: 0.9, pump: true, crush: 0.4 },
    lead: "saw",
    fx: { tune: "hard", oct: true, chip: false, wide: true, crush: true, stutter: true }
  },
  {
    // UK bassline: straight 4x4 at 135-142, claps on 2 and 4, swung hats, reese/sub bass ducked to the kick
    id: "screamo",
    genes: { drums: [0.55, 0.6, 0.47, 0.5], bass: [0.7, 0.8, 0.1, 0.5], chords: [0.4, 0.7, 0.5, 0.4], melody: [0.45, 0.5, 0.5, 0.5] },
    name: "SCREAMO BASS",
    bpm: 138,
    swing: 0.14,
    root: 9, // A
    mode: "minor",
    progressions: ["i iv bVI V", "i bVI iv V", "bVI bVII i i", "iv bVI V V"],
    drums: {
      kick:  "x...x...x...x...",
      clap:  "....x.......x...",
      hat:   "..x...x...x...x.",
      ohat:  ".x.x.x.x.x.x.x.x",
      drive: 0.45
    },
    bass: { sound: "reese", pattern: "x.xx.xx.x.xx.xx.", drive: 0.8, octave: 1, glide: false },
    chords: { style: "stabs", sound: "saw", pattern: "x.....x...x.....", bright: 0.7, pump: true, crush: 0.2 },
    lead: "saw",
    fx: { tune: "hard", oct: false, chip: false, wide: true, crush: true, stutter: false }
  },
  {
    // digicore: trap drums with rolling hats, dreamy plucks and pads, heavy autotune, pitched ad-libs
    id: "digi",
    genes: { drums: [0.5, 0.35, 0.13, 0.4], bass: [0.3, 0.4, 0.6, 0.2], chords: [0.6, 0.6, 0.4, 0.6], melody: [0.55, 0.6, 0.4, 0.7] },
    name: "DIGI ACHE",
    bpm: 150,
    swing: 0.04,
    root: 4, // E
    mode: "major",
    progressions: ["IV V iii vi", "I V vi IV", "vi IV I V", "IVmaj7 iv I I", "ii7 V Imaj7 vi"],
    drums: {
      kick:  "x.......x.x.....",
      clap:  "........x.......",
      hat:   "x.x.x.x.x.xxx.x.",
      ohat:  "................",
      drive: 0.2
    },
    bass: { sound: "808", pattern: "x.......x...x...", drive: 0.35, octave: 1, glide: true },
    chords: { style: "arp", sound: "pluck", pattern: "x.x.x.x.x.x.x.x.", bright: 0.6, pump: false, crush: 0 },
    lead: "pluck",
    fx: { tune: "hard", oct: true, chip: true, wide: true, crush: false, stutter: false }
  },
  {
    // rage: 130-150 (140 common), one minor vamp, short supersaw stabs + quiet octave-down,
    // snare on beat 3, open hat before downbeats, long clipped 808 with slides
    id: "rage",
    genes: { drums: [0.75, 0.85, 0, 0.6], bass: [0.4, 0.95, 0.8, 0.4], chords: [0.5, 1.0, 0.8, 0.3], melody: [0.35, 0.3, 0.7, 0.6] },
    name: "RAGE",
    bpm: 140,
    swing: 0,
    root: 1, // C#
    mode: "minor",
    progressions: ["i i i i", "i i bVI bVI", "i bVII i bVII", "i i bIII bVII"],
    drums: {
      kick:  "x.....x...x.....",
      clap:  "........x.......",
      hat:   "x.x.x.xxx.x.x.xx",
      ohat:  "..............x.",
      drive: 0.6
    },
    bass: { sound: "808", pattern: "x.....x...x...x.", drive: 0.95, octave: 1, glide: true },
    chords: { style: "stabs", sound: "saw", pattern: "x..x..x...x..x..", bright: 1.0, pump: false, crush: 0.15, sub: true },
    lead: "saw",
    fx: { tune: "hard", oct: false, chip: false, wide: true, crush: true, stutter: true }
  },
  {
    // bubblegum-maximalist hyperpop: fast, major, chip squares, chipmunk vocals
    id: "glitter",
    genes: { drums: [0.5, 0.6, 0, 0.7], bass: [0.6, 0.5, 0.1, 0.6], chords: [0.6, 0.8, 0.5, 0.4], melody: [0.6, 0.7, 0.5, 0.8] },
    name: "GLITTER GORE",
    bpm: 175,
    swing: 0,
    root: 0, // C
    mode: "major",
    progressions: ["I V vi IV", "IV I V vi", "I iii IV V", "vi V IV V"],
    drums: {
      kick:  "x...x...x...x...",
      clap:  "....x.......x...",
      hat:   "x.x.x.x.x.x.x.x.",
      ohat:  "..x...x...x...x.",
      drive: 0.5
    },
    bass: { sound: "square", pattern: "x.x.x.x.x.x.x.x.", drive: 0.5, octave: 2, glide: false },
    chords: { style: "stabs", sound: "square", pattern: "x.xx.xx.x.xx.xx.", bright: 0.8, pump: true, crush: 0.35 },
    lead: "square",
    fx: { tune: "hard", oct: true, chip: true, wide: true, crush: false, stutter: true }
  }
];

// Chords offered when you hold a pad to swap it.
export const SWAP_OPTIONS = {
  minor: ["i", "iv", "v", "bIII", "bVI", "bVII", "V", "i7", "iv7", "bVImaj7", "bIIImaj7", "ii°"],
  major: ["I", "ii", "iii", "IV", "V", "vi", "Imaj7", "IVmaj7", "vi7", "ii7", "iv", "bVII"]
};

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10]
};

const DEGREE_SEMITONES = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 };
const NUMERAL_RE = /^(b|#)?(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(°)?(maj7|7)?$/;

// "bVImaj7" in key root 6 -> { rootPc, quality, seventh, notes:[pitch classes], name }
export function parseNumeral(numeral, keyRoot) {
  const m = NUMERAL_RE.exec(numeral.trim());
  if (!m) throw new Error("Bad chord numeral: " + numeral);
  const [, accidental, deg, dim, sev] = m;
  let semis = DEGREE_SEMITONES[deg.toUpperCase()];
  if (accidental === "b") semis -= 1;
  if (accidental === "#") semis += 1;
  const rootPc = (((keyRoot + semis) % 12) + 12) % 12;
  const quality = dim ? "dim" : deg === deg.toUpperCase() ? "maj" : "min";
  const triad = quality === "maj" ? [0, 4, 7] : quality === "min" ? [0, 3, 7] : [0, 3, 6];
  const intervals = sev === "maj7" ? [...triad, 11] : sev === "7" ? [...triad, 10] : triad;
  const suffix = (quality === "min" ? "m" : quality === "dim" ? "°" : "") + (sev || "");
  return {
    numeral,
    rootPc,
    quality,
    intervals,
    name: NOTE_NAMES[rootPc] + suffix
  };
}

// MIDI notes for a chord, voiced into a comfortable middle range (E3..E5).
export function voiceChord(chord) {
  const base = 60 + chord.rootPc;
  return chord.intervals
    .map((iv) => {
      let n = base + iv;
      while (n > 76) n -= 12;
      while (n < 52) n += 12;
      return n;
    })
    .sort((a, b) => a - b);
}

// Pitch classes of the song's scale, e.g. F# minor -> [6,8,9,11,1,2,4]
export function scalePitchClasses(root, mode) {
  return SCALES[mode].map((s) => (root + s) % 12);
}

// MIDI note of scale degree `deg` (0 = root) starting at octave `oct`
export function scaleNote(root, mode, deg, oct) {
  const sc = SCALES[mode];
  const o = Math.floor(deg / sc.length);
  const d = ((deg % sc.length) + sc.length) % sc.length;
  return 12 * (oct + 1) + root + sc[d] + 12 * o;
}

export function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function keyLabel(root, mode) {
  return NOTE_NAMES[root] + (mode === "minor" ? "m" : "");
}

export function vibeById(id) {
  return VIBES.find((v) => v.id === id) || VIBES[0];
}

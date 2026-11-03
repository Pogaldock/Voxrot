# VOXROT

Make hyperpop with your own voice, on your phone, in the browser.

Pick a vibe and every part writes itself in that style. Steer each part with 4 dials, pick from variations ranked for your taste, mutate the whole song a generation at a time, record your own melody on scale-locked keys, then sing over the loop and get it back hard-tuned to the key.

By SYMBIOZE · [@fpv.symbioze](https://instagram.com/fpv.symbioze)

## Use it

Open the GitHub Pages link in Chrome on your phone. Menu, "Add to Home screen" to get it as an app.

- **TRACKS**: one lane per part. Tap to open it, hold to mute. Tap a chord name to change that bar
- **A part**: 4 dials rewrite it live. Variations: tap to try, double-tap to keep, swipe left to kill. Keeps and kills train your taste
- **SOUND tab**: the part's sound genes, lockable, RANDOM IN RANGE stays in style
- **MUTATE**: evolves every unlocked part one generation
- **REC MELODY**: keys appear above the record button, play over one loop
- **REC VOICE**: wired headphones, calibrate sync once in the VOICE screen

## Files

- `js/vibes.js`: every vibe as plain data (tempo, key, drum patterns as `x...` strings, roman-numeral progressions, default dial positions)
- `js/gen.js`: generators, mutation and the taste model. Drums use vibe templates + Euclidean-style density, the 808 follows the kick, melodies put chord tones on strong beats with mostly stepwise motion and reuse 2-3 rhythms
- `js/audio.js`: synths, drums, 808, the clock, mic capture, latency calibration, WAV export
- `js/dsp.js` + `js/dsp-worker.js`: the autotune (YIN pitch detection, PSOLA pitch shifting, formant shift, doubles, crush, stutter) on a background thread
- `js/ui.js`: the interface
- `test/`: `node test/dsp.test.mjs` and `node test/gen.test.mjs`

No build step, no dependencies, no server. Everything runs and stays on the phone.

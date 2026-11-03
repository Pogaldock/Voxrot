# VOXROT

Make hyperpop with your own voice, on your phone, in the browser.

Pick a vibe, reroll the chords until they hit, play the scale-locked keys, then hit the eye and sing over the loop. Your take comes back hard-tuned to the key, with octave layers, chipmunk formants, wide doubles, crush and stutter.

By SYMBIOZE · [@fpv.symbioze](https://instagram.com/fpv.symbioze)

## Use it

Open the GitHub Pages link in Chrome on your phone. Menu, then "Add to Home screen" to get it as an app.

- Wired headphones while recording
- VOX tab, CALIBRATE SYNC once per phone (headphones off for that)
- SONGS tab to save, export a WAV or share straight to an app

## Files

- `js/vibes.js`: every vibe as plain data. Drum patterns are `x...x...` strings, chords are roman numerals. Add or edit vibes here
- `js/dsp.js`: the autotune. YIN pitch detection, scale snapping, PSOLA pitch shifting, formant shift, crush, stutter
- `js/audio.js`: synths, drums, 808, the clock, mic capture, latency calibration, WAV export
- `js/ui.js`: the interface
- `js/capture-worklet.js`: mic capture on the audio thread
- `test/dsp.test.mjs`: autotune tests, run with `node test/dsp.test.mjs`

No build step, no dependencies, no server. Everything runs and stays on the phone.

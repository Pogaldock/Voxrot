// Background thread for the heavy vocal processing, so the beat clock and taps never wait.
import { processTake, detectPitch } from "./dsp.js";

self.onmessage = (e) => {
  const { id, raw, sr, track, opts } = e.data;
  const take = { raw, sr, track: track || detectPitch(raw, sr) };
  const [L, R] = processTake(take, opts);
  self.postMessage({ id, L, R, track: take.track }, [L.buffer, R.buffer]);
};

// Streaming playback processor.
//
// TTS audio arrives as a series of WebSocket deltas that do not line up with
// the audio callback boundaries, so scheduling one AudioBufferSourceNode per
// delta produces audible seams. Instead we push every delta into a ring buffer
// and let this processor pull from it at the exact rate the device consumes.
//
// It reports two things back to the main thread:
//
//   envelope  what is actually being emitted, which drives mouth shapes for
//             the renderers that animate from audio level.
//   played    how many samples of real audio have gone out. A generated
//             picture follows this as its clock; anything that free-runs
//             alongside playback drifts, and the error accumulates over a turn.

const RING_CAPACITY = 16000 * 20;
const ANALYSIS_INTERVAL_BLOCKS = 2;

class AudioPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ring = new Float32Array(RING_CAPACITY);
    this._readIndex = 0;
    this._writeIndex = 0;
    this._available = 0;

    this._played = 0;

    this._blockCount = 0;
    this._rmsAccumulator = 0;
    this._crossingAccumulator = 0;
    this._sampleAccumulator = 0;
    this._lastSign = 0;
    this._wasActive = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) {
        return;
      }
      if (data.type === "push") {
        this._push(data.samples);
      } else if (data.type === "clear") {
        // Barge-in: drop everything still queued so the character stops
        // mid-sentence instead of finishing the buffered turn.
        this._readIndex = 0;
        this._writeIndex = 0;
        this._available = 0;
        this._played = 0;
      }
    };
  }

  _push(samples) {
    if (!samples) {
      return;
    }
    const count = samples.length;
    if (count > RING_CAPACITY - this._available) {
      // Overflow means playback has fallen far behind production. Dropping the
      // oldest audio keeps latency bounded instead of drifting further.
      const overflow = count - (RING_CAPACITY - this._available);
      this._readIndex = (this._readIndex + overflow) % RING_CAPACITY;
      this._available -= overflow;
    }
    for (let i = 0; i < count; i += 1) {
      this._ring[this._writeIndex] = samples[i];
      this._writeIndex = (this._writeIndex + 1) % RING_CAPACITY;
    }
    this._available += count;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }
    const channel = output[0];
    const blockSize = channel.length;

    let sumSquares = 0;
    let crossings = 0;

    for (let i = 0; i < blockSize; i += 1) {
      let sample = 0;
      if (this._available > 0) {
        sample = this._ring[this._readIndex];
        this._readIndex = (this._readIndex + 1) % RING_CAPACITY;
        this._available -= 1;
        // Only real audio advances the clock. Counting underrun silence would
        // march the picture past sound that has not been spoken yet.
        this._played += 1;
      }
      channel[i] = sample;

      sumSquares += sample * sample;
      const sign = sample > 0 ? 1 : sample < 0 ? -1 : 0;
      if (sign !== 0) {
        if (this._lastSign !== 0 && sign !== this._lastSign) {
          crossings += 1;
        }
        this._lastSign = sign;
      }
    }

    for (let c = 1; c < output.length; c += 1) {
      output[c].set(channel);
    }

    this._rmsAccumulator += sumSquares;
    this._crossingAccumulator += crossings;
    this._sampleAccumulator += blockSize;
    this._blockCount += 1;

    if (this._blockCount >= ANALYSIS_INTERVAL_BLOCKS) {
      const rms = Math.sqrt(this._rmsAccumulator / this._sampleAccumulator);
      // Zero-crossing rate stands in for spectral brightness: it is cheap to
      // compute per block and separates bright vowels (ee, ih) from dark ones
      // (oh, ou) well enough to drive mouth shapes.
      const zcr = this._crossingAccumulator / this._sampleAccumulator;
      const active = this._available > 0;

      this.port.postMessage({
        type: "envelope",
        rms: rms,
        zcr: zcr,
        active: active,
        played: this._played,
      });

      if (this._wasActive && !active) {
        this.port.postMessage({ type: "drained" });
      }
      this._wasActive = active;

      this._rmsAccumulator = 0;
      this._crossingAccumulator = 0;
      this._sampleAccumulator = 0;
      this._blockCount = 0;
    }

    return true;
  }
}

registerProcessor("audio-playback", AudioPlaybackProcessor);

// Microphone capture processor.
// Accumulates render quanta (128 samples) into larger frames and posts them to
// the main thread, which converts to PCM16 and streams them over the WebSocket.
// Posting every 128 samples would flood the message port, so we batch.

const FRAME_SIZE = 1024;

class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frame = new Float32Array(FRAME_SIZE);
    this._filled = 0;
    this._muted = false;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === "mute") {
        this._muted = !!data.value;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }
    const channel = input[0];
    if (!channel) {
      return true;
    }

    // While muted we still drain the input so the graph keeps pulling, but we
    // emit silence instead of the captured samples.
    for (let i = 0; i < channel.length; i += 1) {
      this._frame[this._filled] = this._muted ? 0 : channel[i];
      this._filled += 1;

      if (this._filled === FRAME_SIZE) {
        // Transfer a copy: the buffer is reused for the next frame.
        const out = this._frame.slice();
        this.port.postMessage(out, [out.buffer]);
        this._filled = 0;
      }
    }

    return true;
  }
}

registerProcessor("mic-capture", MicCaptureProcessor);

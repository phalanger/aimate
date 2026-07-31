// Microphone capture and streaming playback.
//
// Both directions share one AudioContext pinned to 16 kHz, which is the rate
// the pipeline works in. Letting the context resample the device once is
// cheaper and less error-prone than resampling every chunk ourselves.

const PIPELINE_SAMPLE_RATE = 16000;

function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function pcm16ToFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

function bytesToBase64(bytes) {
  // Chunked to stay clear of the argument-count limit on large buffers.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class AudioEngine {
  constructor() {
    this.context = null;
    this.stream = null;
    this.micNode = null;
    this.playbackNode = null;
    this.sourceNode = null;
    this.recordDestination = null;
    this.onAudioFrame = null;
    this.onMicLevel = null;
    this.onPcm = null;
    this.onPosition = null;
    // Whether the speaker currently has audio to play. Needed because the
    // "drained" edge fires once: if the reply finishes after the buffer
    // already ran dry, nothing would ever signal the end of the turn.
    this.active = false;
    this.onEnvelope = null;
    this.onDrained = null;
    this.running = false;

    // When a renderer generates video from the reply audio, the picture is
    // necessarily a beat behind the sound. Holding playback until the first
    // frames exist trades a little latency for lips that match the voice.
    this.holding = false;
    this.held = [];
  }

  // Whether a microphone is live right now.
  //
  // Derived rather than remembered. It used to be a field that start(), stop()
  // and _startMicrophone() each had to keep true, and the moment capture
  // became something you switch on mid-session, they stopped agreeing: stop()
  // released the stream but left the field set, so the next session believed
  // it had a microphone it had already thrown away and offered no way to ask
  // for another. A value read from the node cannot go stale.
  get micAvailable() {
    return this.micNode !== null;
  }

  async start(options = {}) {
    if (this.running) {
      return;
    }

    this.context = new AudioContext({ sampleRate: PIPELINE_SAMPLE_RATE });

    await this.context.audioWorklet.addModule("./worklets/mic-capture.js");
    await this.context.audioWorklet.addModule("./worklets/audio-playback.js");

    this._startPlayback();
    if (options.microphone) {
      await this._startMicrophone();
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }

    this.running = true;
  }

  async enableMicrophone() {
    if (!this.running || this.micAvailable) {
      return this.micAvailable;
    }
    await this._startMicrophone();
    return this.micAvailable;
  }

  async _startMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return;
    }

    try {
      // Echo cancellation is not optional here: the speaker plays the
      // character's voice into the same room as the microphone, and without
      // AEC the server VAD treats her own output as the user barging in, so
      // she interrupts herself in a loop.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      // No device and permission refused have different cures, and reporting
      // both as "no microphone found" sends the one user who can fix it
      // looking for hardware they already have. Nothing is stored - the name
      // goes to the console and the absence of micNode says the rest.
      console.warn("[audio] microphone unavailable:", err && err.name, err && err.message);
      return;
    }

    // Asking for echo cancellation is not the same as being given it, and the
    // difference only shows up as her answering her own sentences.
    const track = this.stream.getAudioTracks()[0];
    const settings = track ? track.getSettings() : {};
    console.log("[audio] microphone echoCancellation =", settings.echoCancellation);

    this.sourceNode = this.context.createMediaStreamSource(this.stream);
    this.micNode = new AudioWorkletNode(this.context, "mic-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });
    this.micNode.port.onmessage = (event) => {
      const frame = event.data;

      // Level for the visualizer. Computed here rather than in the worklet
      // because the frame is already crossing the port for transmission.
      if (this.onMicLevel) {
        let sum = 0;
        for (let i = 0; i < frame.length; i += 1) {
          sum += frame[i] * frame[i];
        }
        this.onMicLevel(Math.sqrt(sum / frame.length));
      }

      if (!this.onAudioFrame) {
        return;
      }
      const pcm = floatToPcm16(frame);
      this.onAudioFrame(bytesToBase64(new Uint8Array(pcm.buffer)));
    };
    this.sourceNode.connect(this.micNode);
  }

  // A MediaStream carrying only her voice - not the microphone, and not
  // anything else the machine is playing. Recording taps this rather than
  // capturing the system output, so a notification sound or a video in
  // another tab cannot end up in a saved reply.
  captureStream() {
    return this.recordDestination ? this.recordDestination.stream : null;
  }

  _startPlayback() {
    this.playbackNode = new AudioWorkletNode(this.context, "audio-playback", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.playbackNode.port.onmessage = (event) => {
      const data = event.data;
      if (!data) {
        return;
      }
      if (data.type === "envelope") {
        this.active = !!data.active;
        if (this.onEnvelope) {
          this.onEnvelope(data.rms, data.zcr, data.active);
        }
        if (this.onPosition) {
          this.onPosition(data.played, data.active);
        }
      } else if (data.type === "drained" && this.onDrained) {
        this.onDrained();
      }
    };
    this.playbackNode.connect(this.context.destination);

    // Connected up front rather than when a recording starts: a graph edge
    // added mid-playback would miss the samples already in flight, and an
    // unread destination node costs nothing.
    this.recordDestination = this.context.createMediaStreamDestination();
    this.playbackNode.connect(this.recordDestination);
  }

  enqueueAudio(base64Chunk) {
    if (!this.playbackNode) {
      return;
    }
    const bytes = base64ToBytes(base64Chunk);
    // Hand the raw PCM on before it is converted: the lip-sync service wants
    // the same int16 stream the speaker is about to play.
    if (this.onPcm) {
      this.onPcm(bytes);
    }
    const samples = pcm16ToFloat(bytes);
    if (this.holding) {
      this.held.push(samples);
      return;
    }
    this.playbackNode.port.postMessage({ type: "push", samples: samples }, [samples.buffer]);
  }

  holdPlayback() {
    this.holding = true;
    this.held.length = 0;
  }

  releasePlayback() {
    this.holding = false;
    if (!this.playbackNode) {
      this.held.length = 0;
      return;
    }
    for (const samples of this.held) {
      this.playbackNode.port.postMessage({ type: "push", samples: samples }, [samples.buffer]);
    }
    this.held.length = 0;
  }

  isActive() {
    return this.active || this.holding || this.held.length > 0;
  }

  clearPlayback() {
    this.active = false;
    this.holding = false;
    this.held.length = 0;
    if (this.playbackNode) {
      this.playbackNode.port.postMessage({ type: "clear" });
    }
  }

  setMuted(muted) {
    if (this.micNode) {
      this.micNode.port.postMessage({ type: "mute", value: !!muted });
    }
  }

  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.micNode) {
      this.micNode.disconnect();
      this.micNode = null;
    }
    if (this.playbackNode) {
      this.playbackNode.disconnect();
      this.playbackNode = null;
    }
    this.recordDestination = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
  }
}

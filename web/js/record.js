// Saves the last reply as a video file.
//
// Recording is a screen capture of the stage rather than a re-render: the four
// renderers produce their picture in completely different ways - WebGL for 3D,
// pixi for 2D, decoded video frames for the real-footage ones - and copying
// whatever each of them already drew is the only approach that is one
// implementation instead of four. It also means every display mode can be
// saved, including the ones that generate nothing of their own.
//
// The consequence is that recording happens in real time: the reply has to be
// played through to be captured. The save button therefore replays the cached
// turn and records that, which costs the length of the reply and no model
// time at all.
//
// The browser can only produce WebM. Muxing a subtitle track into it is not
// something MediaRecorder can do, so the finished blob is handed to the panel
// server, which has ffmpeg and turns it into the requested container.

// Kept well above the final encode: this is an intermediate that gets
// re-encoded, and quality lost here cannot be recovered by the second pass.
const INTERMEDIATE_BITS_PER_SECOND = 8_000_000;

const CAPTURE_FPS = 25;

// Larger than this and the encode starts costing more than the result is
// worth for something being watched on the same machine that made it.
const MAX_WIDTH = 1280;

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function recordingSupported() {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

function pickMimeType() {
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

function sourceSize(element) {
  const width = element.videoWidth || element.width || element.clientWidth;
  const height = element.videoHeight || element.height || element.clientHeight;
  if (!width || !height) {
    return null;
  }
  const scale = Math.min(1, MAX_WIDTH / width);
  // Even dimensions: yuv420p, which is what x264 will encode to, cannot
  // represent an odd width or height.
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}

export class Recorder {
  constructor() {
    this.recorder = null;
    this.canvas = null;
    this.ctx = null;
    this.chunks = [];
    this.running = false;
    this.frameHandle = 0;
  }

  /**
   * @param source     function returning the element currently being displayed
   * @param audioTrack MediaStreamTrack carrying the reply audio, or null
   */
  start(source, audioTrack) {
    if (this.running) {
      return false;
    }
    const element = source();
    const size = element && sourceSize(element);
    if (!size) {
      return false;
    }

    this.canvas = document.createElement("canvas");
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    this.ctx = this.canvas.getContext("2d");
    // Set once and never changed, because every frame repaints the background
    // with it - see paint(). The first frames are also captured before the
    // source has necessarily drawn anything, and black is a better opening
    // frame than an uninitialised buffer.
    this.ctx.fillStyle = "#000";
    this.ctx.fillRect(0, 0, size.width, size.height);

    const stream = this.canvas.captureStream(CAPTURE_FPS);
    if (audioTrack) {
      stream.addTrack(audioTrack);
    }

    const mimeType = pickMimeType();
    this.chunks = [];
    this.recorder = new MediaRecorder(
      stream,
      mimeType
        ? { mimeType: mimeType, videoBitsPerSecond: INTERMEDIATE_BITS_PER_SECOND }
        : { videoBitsPerSecond: INTERMEDIATE_BITS_PER_SECOND }
    );
    this.recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) {
        this.chunks.push(event.data);
      }
    };

    this.running = true;
    this.recorder.start();

    // Redrawn every frame rather than on a timer: the source is being animated
    // by the renderer's own loop, and matching it is what keeps the capture
    // free of duplicated and skipped frames.
    const paint = () => {
      if (!this.running) {
        return;
      }
      const current = source();
      if (current) {
        // Repainted rather than drawn over. The 3D and 2D renderers hand back
        // a canvas with a transparent background - the character is composited
        // onto the stage by CSS, not painted onto it - so drawing frame after
        // frame into the same buffer accumulated every previous pose and the
        // saved video came out full of ghost trails. The real-footage
        // renderers hid it: their frames are opaque and cover everything.
        //
        // Black to match the stage, whose background is a near-black gradient
        // (#101116 -> #0a0b0e), and because the destination has to be opaque
        // anyway: the second pass encodes yuv420p, which has no alpha.
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        try {
          this.ctx.drawImage(current, 0, 0, this.canvas.width, this.canvas.height);
        } catch (err) {
          // Source not ready this frame. This now costs a black frame rather
          // than repeating the previous one, which is the price of clearing;
          // it only happens before a video element has its first frame, when
          // the picture is black regardless.
        }
      }
      this.frameHandle = requestAnimationFrame(paint);
    };
    this.frameHandle = requestAnimationFrame(paint);
    return true;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.running || !this.recorder) {
        resolve(null);
        return;
      }
      this.running = false;
      cancelAnimationFrame(this.frameHandle);

      const recorder = this.recorder;
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "video/webm" });
        this.chunks = [];
        this.recorder = null;
        this.canvas = null;
        this.ctx = null;
        resolve(blob.size ? blob : null);
      };
      recorder.stop();
    });
  }

  cancel() {
    if (!this.running) {
      return;
    }
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
    if (this.recorder) {
      this.recorder.onstop = null;
      try {
        this.recorder.stop();
      } catch (err) {
        // Already stopping.
      }
      this.recorder = null;
    }
    this.chunks = [];
    this.canvas = null;
    this.ctx = null;
  }
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

/**
 * Hand the recording to the server for muxing.
 *
 * Sent as base64 inside JSON rather than as multipart: the payload has to
 * carry the subtitle text alongside the video, and the panel server is
 * stdlib-only, where parsing multipart is more code than the third of a
 * megabyte this costs on a typical reply.
 */
export async function uploadRecording(blob, options) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const response = await fetch("/api/record", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video: bytesToBase64(buffer),
      subtitle: options.subtitle || "",
      mode: options.mode || "none",
      crf: options.crf,
      name: options.name || "",
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || String(response.status));
  }
  return data;
}

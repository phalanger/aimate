// MuseTalk renderer: real lip sync on real footage.
//
// Two layers sit on top of each other:
//
//   video    the source clip on loop. Shown between turns, so the character
//            keeps breathing and shifting without costing any inference.
//   canvas   frames generated from the reply audio. Shown while speaking.
//
// Generating idle frames would burn the GPU reproducing footage we already
// have, so the switch happens per turn. To keep it from looking like a cut,
// the video's current frame number is handed to the service before each turn
// and generation continues from that point in the same cycle.
//
// Frames are displayed against the speaker's playback position rather than a
// timer of their own. A free-running timer looks right for a second and then
// drifts: whenever generation stalls the timer keeps counting, the queue
// underruns, and the picture falls a little further behind the voice with
// every stall. Indexing off samples actually played turns a stall into a
// brief freeze that corrects itself instead of a permanent offset.
//
// The service runs in its own process (port 8930) because MuseTalk needs
// torch 2.0 / CUDA 11.8 while the voice pipeline runs torch 2.9 / CUDA 12.8.

import { setting } from "./settings.js";

// Same reasoning as the realtime endpoint: follow the page's host so the
// panel works from another device on the network.
const SERVICE_HOST = window.location.hostname;
const SERVICE_WS = "ws://" + SERVICE_HOST + ":8930/stream";
const SERVICE_HTTP = "http://" + SERVICE_HOST + ":8930";

const PIPELINE_SAMPLE_RATE = 16000;

// Envelope reports arrive about every 16 ms, so this is roughly a third of a
// second of a stopped playhead before the turn is called finished.
const IDLE_REPORTS_TO_END = 20;

// How long to wait for the service to answer a new connection before
// treating it as unreachable. Generous: it only has to beat a human
// noticing, and the service answers in milliseconds when it is healthy.
const CONNECT_TIMEOUT_MS = 8000;

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Playback waits for the whole turn to be generated before it starts.
//
// Streaming the picture out as it is produced only works if generation is
// reliably faster than playback. Measured alone it is (about 0.9x realtime),
// but during a conversation the same GPU is synthesising the speech at the
// same time, and generation slips past 1.0x. Once it does, no amount of
// head start helps: the gap grows for as long as the reply lasts, which is
// the "sound ahead of the mouth" symptom. Replaying a cached turn stays in
// sync precisely because every frame already exists.
//
// So the turn is completed first and then played, which makes live replies
// behave exactly like a replay. The cost is that a reply starts speaking
// after it has been generated rather than during.
//
// These are the defaults; the live values come from settings.json through the
// settings dialog, so the trade-off is the user's to make without editing code.
const WAIT_FOR_COMPLETE_TURN = true;

// Safety valve for the buffered mode: if the service never reports the turn
// finished, start anyway once this much picture exists rather than waiting
// forever in silence.
const MAX_WAIT_SECONDS = 12.0;

// Head start used when streaming (WAIT_FOR_COMPLETE_TURN = false).
const LEAD_SECONDS = 2.0;

export class MuseTalkStage {
  constructor(container, config) {
    this.container = container;
    this.config = config;
    this.socket = null;
    this.ready = false;
    // Set before tearing down so the socket's own close handler knows the
    // disconnect was intentional. Without it, switching this character to a
    // different display mode reports "service unreachable" - the act of
    // leaving raises the error.
    this.disposed = false;
    this.cycle = 0;
    this.fps = 25;

    // Frames for the current turn, in generation order. Index 0 is the first
    // frame of the reply and lines up with sample 0 of its audio.
    this.frames = [];
    this.turnActive = false;
    this.showing = false;
    this.drawn = -1;
    this.seekIndex = 0;
    // The speaker's sample counter runs for the whole session, while frames
    // are per turn. Without an offset, turn two asks for a frame number far
    // past the end of its own list and every lookup clamps to the newest
    // frame - which plays back as a slideshow of one or two stills.
    this.baseSamples = null;
    // Bumped on every turn boundary so decodes still in flight from an
    // abandoned turn do not land in the new one's frame list.
    this.turnToken = 0;
    this.isReplay = false;
    this.turnComplete = false;
    this.lastPlayed = -1;
    this.idleReports = 0;
    // Frames of the turn that just finished. Replaying re-uses them rather
    // than asking the service to generate the same mouth shapes again.
    this.lastFrames = [];

    this.video = document.createElement("video");
    this.video.className = "stage-video";
    this.video.src = config.idle_video;
    this.video.loop = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = "auto";

    this.canvas = document.createElement("canvas");
    this.canvas.className = "stage-video";
    this.canvas.style.opacity = "0";
    this.ctx = this.canvas.getContext("2d");

    container.appendChild(this.video);
    container.appendChild(this.canvas);
  }

  async start() {
    try {
      await this.video.play();
    } catch (err) {
      // Autoplay may be blocked until the page is interacted with; the
      // connect button provides that gesture.
    }
    await this._connect();
  }

  _connect() {
    return new Promise((resolve) => {
      const url = SERVICE_WS + "?avatar=" + encodeURIComponent(this.config.avatar_id);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      this.socket = socket;

      // A socket that opens and then says nothing would leave this promise
      // pending for ever. That is not a stalled connection but a stalled app:
      // mount() never returns, so the stage stays mid-swap, and from then on
      // every retry and every character switch returns immediately without
      // doing anything. Reloading the page was the only way out.
      const timer = setTimeout(() => {
        fail("service_unreachable");
      }, CONNECT_TIMEOUT_MS);

      const settle = () => {
        clearTimeout(timer);
        resolve();
      };

      // Without this, a service that is down looks identical to one that is
      // working but silent: the idle clip loops and the mouth never moves,
      // with nothing anywhere to say why.
      const fail = (reason) => {
        this.ready = false;
        this._report(reason);
        settle();
      };

      socket.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(message.data);
        } catch (err) {
          return;
        }
        this._handle(event);
        if (event.type === "ready") {
          settle();
        }
      };
      socket.onerror = () => {
        if (!this.disposed) {
          fail("service_unreachable");
        } else {
          settle();
        }
      };
      socket.onclose = () => {
        if (this.disposed) {
          settle();
          return;
        }
        if (!this.ready) {
          fail("service_unreachable");
        } else {
          this.ready = false;
          this._report("service_closed");
        }
      };
    });
  }

  sourceElement() {
    return this.showing ? this.canvas : this.video;
  }

  headRect() {
    // The source footage is framed on the person, so the face sits high and
    // centred. There is no landmark data on this side to be more exact.
    return { x: 0.5, y: 0.3, w: 0.36, h: 0.36 };
  }

  _report(reason) {
    if (this.onStatus) {
      this.onStatus(reason);
    }
  }

  _handle(event) {
    if (event.type === "ready") {
      this.ready = true;
      this.cycle = event.cycle || 0;
      this.fps = event.fps || 25;
    } else if (event.type === "frame") {
      this._enqueue(event.data);
    } else if (event.type === "flushed") {
      // Everything for this turn has been generated; nothing more is coming.
      this.turnComplete = true;
      this._maybeStart();
    } else if (event.type === "chunk_error") {
      // One chunk failed. The turn continues without it rather than hanging.
      this.turnComplete = true;
      this._maybeStart();
    } else if (event.type === "error") {
      this.ready = false;
      this._report(event.message || "service_error");
    }
  }

  _enqueue(base64) {
    // createImageBitmap decodes off the main thread and yields something the
    // canvas can draw directly. Decoding via an Image and a data: URL happens
    // on the main thread instead, and at 25 frames a second it competes with
    // the rendering it is feeding - frames then arrive later than the audio
    // they belong to even though the bytes were here on time.
    const bytes = base64ToBytes(base64);
    const blob = new Blob([bytes], { type: "image/jpeg" });

    // Reserve the slot now so frames stay in generation order regardless of
    // the order the decodes happen to finish in.
    const slot = this.frames.length;
    this.frames.push(null);
    const turn = this.turnToken;

    createImageBitmap(blob)
      .then((bitmap) => {
        if (turn !== this.turnToken) {
          bitmap.close();
          return;
        }
        this.frames[slot] = bitmap;
        this._maybeStart();
      })
      .catch(() => {
        // A frame that will not decode is dropped rather than stalling the
        // turn; the previous one stays on screen for its slot.
      });
  }

  _leadFrames() {
    return Math.max(2, Math.round(setting("lead_seconds", LEAD_SECONDS) * this.fps));
  }

  // Decides whether there is enough picture to let the speaker go.
  _maybeStart() {
    if (this.showing || !this.turnActive) {
      return;
    }
    const decoded = this._decodedCount();
    if (decoded < 2) {
      return;
    }

    // Read per turn rather than captured at load: changing the switch in
    // settings then takes effect on the next reply.
    // A finished turn releases playback in either mode. The head start only
    // exists to stay ahead of generation that is still running; once the
    // service has flushed, there is nothing left to stay ahead of.
    //
    // Without this, a reply shorter than lead_seconds never reaches the
    // threshold and the speaker is held until the release timeout - which
    // reads as the reply simply not coming out. Short replies are the common
    // case here, not the exception: the persona rules cap them at two
    // sentences.
    let go = this.turnComplete;
    if (!go) {
      if (setting("wait_for_complete_turn", WAIT_FOR_COMPLETE_TURN)) {
        go = decoded >= setting("max_wait_seconds", MAX_WAIT_SECONDS) * this.fps;
      } else {
        go = decoded >= this._leadFrames();
      }
    }
    if (!go) {
      return;
    }

    this._showCanvas();
    if (this.onPlaybackStart) {
      this.onPlaybackStart();
    }
  }

  _decodedCount() {
    let count = 0;
    for (const frame of this.frames) {
      if (!frame) {
        break;
      }
      count += 1;
    }
    return count;
  }

  _showCanvas() {
    this.showing = true;
    this.canvas.style.opacity = "1";
    this.video.style.opacity = "0";
  }

  _showVideo() {
    this.showing = false;
    this.canvas.style.opacity = "0";
    this.video.style.opacity = "1";
    this.video.play().catch(() => {});
  }

  // ---------- called by the app ----------

  beginTurn() {
    if (this.turnActive) {
      return;
    }
    this.turnActive = true;
    this.turnToken += 1;
    this.isReplay = false;
    this.turnComplete = false;
    this.frames = [];
    this.drawn = -1;
    this.baseSamples = null;
    this.lastPlayed = -1;
    this.idleReports = 0;

    if (!this.ready || !this.socket) {
      return;
    }
    // Hand the current pose over so generation continues from it and the
    // switch from idle footage to generated frames is not a visible cut.
    const index = Math.round((this.video.currentTime || 0) * this.fps);
    this.seekIndex = index;
    this.socket.send(JSON.stringify({ type: "seek", index: index }));
  }

  pushAudio(pcmBytes) {
    if (this.ready && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(pcmBytes);
    }
  }

  // Driven by the playback worklet's reports. `played` counts samples of real
  // audio that have left the speaker, so this is the one clock both the sound
  // and the picture share.
  setAudioPosition(played, active) {
    if (!this.showing) {
      return;
    }

    // End of turn is decided here rather than from an event, because the
    // "buffer ran dry" edge and the "response finished" message can arrive in
    // either order and either one alone can be missed. A playhead that has
    // stopped moving with no audio left is unambiguous.
    if (played === this.lastPlayed && !active) {
      this.idleReports += 1;
      if (this.idleReports >= IDLE_REPORTS_TO_END) {
        this._finishTurn();
        return;
      }
    } else {
      this.idleReports = 0;
    }
    this.lastPlayed = played;
    // First report after the speaker was released marks this turn's origin.
    if (this.baseSamples === null) {
      this.baseSamples = played;
    }
    const elapsed = Math.max(0, played - this.baseSamples);
    const wanted = Math.floor((elapsed * this.fps) / PIPELINE_SAMPLE_RATE);
    const index = Math.min(wanted, this._decodedCount() - 1);
    if (index < 0 || index === this.drawn) {
      // Nothing generated yet, or the right frame is already on screen. Being
      // behind here shows as a held frame that catches up on its own.
      return;
    }
    const image = this.frames[index];
    if (!image) {
      // Still decoding. Holding the current frame is better than blanking;
      // the next report picks up wherever the audio has reached by then.
      return;
    }
    if (this.canvas.width !== image.width) {
      this.canvas.width = image.width;
      this.canvas.height = image.height;
    }
    this.ctx.drawImage(image, 0, 0);
    this.drawn = index;
  }

  endTurn() {
    if (this.ready && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "flush" }));
    }
  }

  canReplay() {
    return this.lastFrames.length > 0;
  }

  // Replay shows the cached frames against the replayed audio. No seek is
  // sent: the service is not involved at all, so the pose the frames were
  // generated from is still the right one.
  beginReplay() {
    if (!this.lastFrames.length) {
      return false;
    }
    this.turnActive = true;
    this.turnToken += 1;
    // Replaying the cache, not producing a new turn. The bitmaps belong to
    // lastFrames and must survive this turn ending - copying the array does
    // not copy them, and closing them here is what turned the second replay
    // into a black screen.
    this.isReplay = true;
    // A replay is complete by definition - every frame is already in hand.
    this.turnComplete = true;
    this.frames = this.lastFrames.slice();
    this.drawn = -1;
    this.lastPlayed = -1;
    this.idleReports = 0;
    this.baseSamples = null;
    // Same path as a live turn: _maybeStart fires onPlaybackStart, which is
    // what releases the speaker. Showing the canvas directly here let the
    // picture begin before the sound did.
    this._maybeStart();
    return true;
  }

  interrupt() {
    if (this.ready && this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "reset" }));
    }
    this._finishTurn();
  }

  // The speaker has gone quiet: hand the loop back the pose it stopped on and
  // return to idle footage. Leaving the canvas up freezes the character on her
  // last frame, which is exactly what a missing reset looks like.
  silence() {
    this._finishTurn();
  }

  _finishTurn() {
    if (!this.turnActive && !this.showing) {
      return;
    }
    this.turnActive = false;

    if (this.showing && this.cycle > 0) {
      const stopped = this.seekIndex + Math.max(this.drawn, 0);
      const position = ((stopped % this.cycle) + this.cycle) % this.cycle;
      // The cycle is the clip forwards then backwards, so the second half maps
      // onto the same source frames in reverse.
      const forward = position < this.cycle / 2 ? position : this.cycle - 1 - position;
      const target = forward / this.fps;
      if (isFinite(target) && this.video.duration && target < this.video.duration) {
        this.video.currentTime = target;
      }
    }

    if (this.isReplay) {
      // The frames were borrowed from the cache; drop the references only.
      this.frames = [];
      this.isReplay = false;
    } else if (this.frames.length) {
      // ImageBitmaps hold GPU memory until closed, so the previous turn's
      // cache is released as this one replaces it.
      this._release(this.lastFrames);
      this.lastFrames = this.frames;
      this.frames = [];
    } else {
      this.frames = [];
    }
    this.drawn = -1;
    this.baseSamples = null;
    this._showVideo();
  }

  _release(frames) {
    for (const frame of frames) {
      if (frame && typeof frame.close === "function") {
        frame.close();
      }
    }
    frames.length = 0;
  }

  dispose() {
    this.disposed = true;
    this._release(this.frames);
    this._release(this.lastFrames);
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
  }
}

export async function listAvatars() {
  const response = await fetch(SERVICE_HTTP + "/avatars", { cache: "no-store" });
  return response.json();
}

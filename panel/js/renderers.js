// Stage renderers.
//
// Each character picks how it is drawn: an abstract orb, a 3D VRM model, a
// looping video of a person, or (later) a Live2D rig. They all present the
// same surface to the app, so switching characters swaps the renderer without
// the conversation code knowing anything about it.
//
// Interface:
//   mount(container)              build DOM, start animating
//   setState(name)                idle | listening | thinking | speaking
//   setLevel(rms, zcr, active)    audio envelope of whatever is playing
//   silence()                     drop to rest immediately
//   dispose()                     tear down, free GPU resources
//
// Heavy dependencies are loaded on demand: three.js and three-vrm together are
// about 3 MB, and a user who only ever runs the orb should never pay for them.

class BaseRenderer {
  constructor(character, options) {
    this.character = character;
    this.options = options || {};
    this.container = null;
  }

  mount() {}
  // True when this renderer produces the picture from the reply audio, so the
  // speaker must wait for it. Only MuseTalk does.
  gatesAudio() {
    return false;
  }
  setState() {}
  setLevel() {}
  pushAudio() {}
  // Samples of reply audio played so far. Renderers that generate the picture
  // use it as their clock; the rest ignore it.
  setAudioPosition() {}
  endTurn() {}
  // Renderers that generate the picture can show a cached turn again; the
  // rest simply animate from the replayed audio like any other.
  beginReplay() {
    return false;
  }
  // Renderers that can act out a reply override this; the rest ignore it.
  playMotionFor() {}
  silence() {}
  dispose() {
    if (this.container) {
      this.container.innerHTML = "";
      this.container = null;
    }
  }
}

class OrbRenderer extends BaseRenderer {
  async mount(container) {
    this.container = container;
    container.innerHTML = "";

    const canvas = document.createElement("canvas");
    canvas.className = "stage-canvas";
    container.appendChild(canvas);

    const { Orb } = await import("./orb.js");
    this.orb = new Orb(canvas);
    this.orb.start();
    this.canvas = canvas;
  }

  sourceElement() {
    return this.canvas || null;
  }

  headRect() {
    // The orb is centred, so "head" is just the middle of the frame.
    return { x: 0.5, y: 0.5, w: 0.4, h: 0.4 };
  }

  setState(name) {
    if (this.orb) {
      this.orb.setState(name);
    }
  }

  setLevel(rms) {
    if (this.orb) {
      this.orb.setLevel(rms);
    }
  }

  silence() {
    if (this.orb) {
      this.orb.silence();
    }
  }
}

class VrmRenderer extends BaseRenderer {
  async mount(container) {
    this.container = container;
    container.innerHTML = "";

    const canvas = document.createElement("canvas");
    canvas.className = "stage-canvas";
    container.appendChild(canvas);

    // Dynamic: pulls in three.js and three-vrm only for VRM characters.
    const { Avatar } = await import("./avatar.js");
    this.avatar = new Avatar(canvas);
    // Framing is per character: a tall model and a chibi one want very
    // different views, so remembering one global number would be wrong for
    // whichever was set second.
    const view = (this.character.avatar && this.character.avatar.view) || {};
    this.avatar.zoom = view.zoom || 1;
    this.avatar.offsetY = view.offsetY || 0;
    this.avatar.onViewChange = (zoom, offsetY) => {
      if (this.options.onViewChange) {
        this.options.onViewChange(zoom, offsetY);
      }
    };
    this.avatar.start();

    const source = this.character.avatar && this.character.avatar.vrm;
    if (source) {
      await this.avatar.load(source);
    }
    this.avatar.setEmotion(this.character.emotion || "neutral");

    const motion = this.character.avatar && this.character.avatar.motion;
    if (motion) {
      try {
        await this.avatar.loadAnimation(motion);
      } catch (err) {
        // A motion that will not load leaves the rest pose in place rather
        // than failing the whole character.
      }
    }
    this.canvas = canvas;
  }

  sourceElement() {
    return this.canvas || null;
  }

  headRect() {
    // Projected from the head bone, so the crop follows the model rather than
    // assuming where it stands.
    return this.avatar ? this.avatar.headScreenRect() : null;
  }

  setState() {
    // The VRM reads state from the audio envelope alone; a separate visual
    // state would fight the lip-sync.
  }

  // Called once per reply with what she is about to say, so the motion can
  // match it.
  async playMotionFor(text) {
    if (!this.avatar) {
      return;
    }
    const { chooseMotion } = await import("./motions.js");
    const { setting } = await import("./settings.js");

    const mode = setting("motion_mode", "auto");
    const configured = (this.character.avatar && this.character.avatar.motion) || "";
    const available = (this.options.motions && this.options.motions()) || [];
    const chosen = chooseMotion(mode, configured, available, text);
    if (!chosen) {
      return;
    }
    try {
      await this.avatar.loadAnimation(chosen, { once: setting("motion_once", false) });
    } catch (err) {
      // Keep whatever is already playing rather than dropping to a T-pose.
    }
  }

  setLevel(rms, zcr, active) {
    if (this.avatar) {
      this.avatar.setEnvelope(rms, zcr, active);
    }
  }

  silence() {
    if (this.avatar) {
      this.avatar.silence();
    }
  }

  dispose() {
    this.avatar = null;
    super.dispose();
  }
}

// Two looping clips crossfaded by state. No inference involved, so the body
// language - breathing, shoulders, blinking - is whatever the source footage
// does, which reads as far more alive than a still frame. The mouth does not
// match the words; that is what the MuseTalk renderer is for.
class VideoRenderer extends BaseRenderer {
  async mount(container) {
    this.container = container;
    container.innerHTML = "";

    const config = this.character.avatar || {};
    this.idle = this._makeVideo(config.idle_video);
    this.talk = config.talk_video ? this._makeVideo(config.talk_video) : null;

    if (this.idle) {
      container.appendChild(this.idle);
    }
    if (this.talk) {
      container.appendChild(this.talk);
    }

    this._showTalking(false);

    // Both clips play continuously. Starting one on demand costs a decode
    // stall at exactly the moment the character begins speaking.
    for (const video of [this.idle, this.talk]) {
      if (video) {
        try {
          await video.play();
        } catch (err) {
          // Autoplay can be refused until the page has been interacted with;
          // the connect button covers that in practice.
        }
      }
    }
  }

  _makeVideo(src) {
    if (!src) {
      return null;
    }
    const video = document.createElement("video");
    video.className = "stage-video";
    video.src = src;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    return video;
  }

  _showTalking(talking) {
    const useTalk = talking && this.talk;
    if (this.idle) {
      this.idle.style.opacity = useTalk ? "0" : "1";
    }
    if (this.talk) {
      this.talk.style.opacity = useTalk ? "1" : "0";
    }
  }

  setState(name) {
    this.talking = name === "speaking";
    this._showTalking(this.talking);
  }

  // No head inset on real footage: a floating crop of a person's face reads
  // as a glitch rather than a feature, and the per-frame copy competes with
  // video decoding on the main thread.
  sourceElement() {
    return null;
  }

  setLevel() {}

  silence() {
    this._showTalking(false);
  }

  dispose() {
    for (const video of [this.idle, this.talk]) {
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
    }
    this.idle = null;
    this.talk = null;
    super.dispose();
  }
}

class Live2DRenderer extends BaseRenderer {
  async mount(container) {
    this.container = container;
    container.innerHTML = "";

    const canvas = document.createElement("canvas");
    canvas.className = "stage-canvas";
    container.appendChild(canvas);

    const { Live2DStage } = await import("./live2d.js");
    this.live2d = new Live2DStage(canvas);
    const view = (this.character.avatar && this.character.avatar.view) || {};
    this.live2d.zoom = view.zoom || 1;
    this.live2d.offsetY = view.offsetY !== undefined ? view.offsetY : 0.12;
    this.live2d.onViewChange = (zoom, offsetY) => {
      if (this.options.onViewChange) {
        this.options.onViewChange(zoom, offsetY);
      }
    };
    await this.live2d.load(this.character.avatar.live2d);
    this.canvas = canvas;
  }

  sourceElement() {
    return this.canvas || null;
  }

  headRect() {
    return this.live2d ? this.live2d.headScreenRect() : null;
  }

  setState() {}

  setLevel(rms, zcr, active) {
    if (this.live2d) {
      this.live2d.setEnvelope(rms, zcr, active);
    }
  }

  // Live2D carries its own motion3.json groups, so there is nothing to choose
  // from the vrma folder - the model's own set is used instead.
  async playMotionFor() {
    if (this.live2d) {
      this.live2d.playRandomMotion();
    }
  }

  silence() {
    if (this.live2d) {
      this.live2d.silence();
    }
  }

  dispose() {
    if (this.live2d) {
      this.live2d.dispose();
      this.live2d = null;
    }
    super.dispose();
  }
}

// Real footage with generated lip sync. Unlike the other renderers this one
// needs the reply audio, not just its envelope, so the app feeds it PCM.
class MuseTalkRenderer extends BaseRenderer {
  gatesAudio() {
    return true;
  }

  async mount(container) {
    this.container = container;
    container.innerHTML = "";

    const { MuseTalkStage } = await import("./musetalk.js");
    this.stage = new MuseTalkStage(container, this.character.avatar);
    this.stage.onPlaybackStart = () => {
      if (this.options.onPictureReady) {
        this.options.onPictureReady();
      }
    };
    this.stage.onStatus = (reason) => {
      if (this.options.onRendererStatus) {
        this.options.onRendererStatus(reason);
      }
    };
    await this.stage.start();
  }

  setState(name) {
    if (!this.stage) {
      return;
    }
    if (name === "speaking") {
      this.stage.beginTurn();
    } else if (name === "listening") {
      this.stage.interrupt();
    }
  }

  setLevel() {}

  // Deliberately none: see VideoRenderer. On this path the cost lands exactly
  // where the picture is already struggling to keep pace with the voice.
  sourceElement() {
    return null;
  }

  // The app routes decoded TTS audio here in addition to the speaker.
  pushAudio(pcmBytes) {
    if (this.stage) {
      this.stage.pushAudio(pcmBytes);
    }
  }

  setAudioPosition(played, active) {
    if (this.stage) {
      this.stage.setAudioPosition(played, active);
    }
  }

  beginReplay() {
    return this.stage ? this.stage.beginReplay() : false;
  }

  endTurn() {
    if (this.stage) {
      this.stage.endTurn();
    }
  }

  silence() {
    if (this.stage) {
      this.stage.silence();
    }
  }

  dispose() {
    if (this.stage) {
      this.stage.dispose();
      this.stage = null;
    }
    super.dispose();
  }
}

const RENDERERS = {
  orb: OrbRenderer,
  vrm: VrmRenderer,
  video: VideoRenderer,
  live2d: Live2DRenderer,
  musetalk: MuseTalkRenderer,
};

export function rendererTypes() {
  return Object.keys(RENDERERS);
}

export function createRenderer(character, options) {
  const config = character.avatar || {};
  let type = config.type || "orb";

  // Fall back rather than fail: a character pointing at a renderer that is not
  // built yet should still be usable, just plainer.
  if (!RENDERERS[type]) {
    type = "orb";
  }
  if (type === "vrm" && !config.vrm) {
    type = "orb";
  }
  if (type === "video" && !config.idle_video) {
    type = "orb";
  }
  if (type === "live2d" && !config.live2d) {
    type = "orb";
  }
  if (type === "musetalk" && !(config.avatar_id && config.idle_video)) {
    type = "orb";
  }

  return new RENDERERS[type](character, options);
}

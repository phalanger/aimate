// Owns the visual stage and the renderer currently on it.
//
// Switching characters can mean switching renderer, which involves loading
// modules and media. This serialises those swaps and replays the last known
// state onto whatever ends up mounted, so a switch mid-sentence cannot leave
// the stage frozen in the wrong pose.

import { createRenderer } from "./renderers.js";

export class Stage {
  constructor(container, options) {
    this.container = container;
    this.options = options || {};
    this.renderer = null;
    this.state = "idle";
    this.pending = null;
    this.swapping = false;
  }

  async setCharacter(character) {
    // Coalesce: only the most recent request matters if several arrive while
    // a previous swap is still loading.
    this.pending = character;
    if (this.swapping) {
      return;
    }

    this.swapping = true;
    try {
      while (this.pending) {
        const target = this.pending;
        this.pending = null;

        if (this.renderer) {
          this.renderer.dispose();
          this.renderer = null;
        }

        const renderer = createRenderer(target, this.options);
        await renderer.mount(this.container);

        // Only publish once mounting succeeded, so a failed load cannot leave
        // a half-built renderer receiving audio callbacks.
        this.renderer = renderer;
        this.renderer.setState(this.state);
      }
    } finally {
      this.swapping = false;
    }
  }

  playMotionFor(text) {
    if (this.renderer) {
      this.renderer.playMotionFor(text);
    }
  }

  sourceElement() {
    return this.renderer && this.renderer.sourceElement ? this.renderer.sourceElement() : null;
  }

  captureElement() {
    return this.renderer && this.renderer.captureElement ? this.renderer.captureElement() : null;
  }

  gatesAudio() {
    return !!(this.renderer && this.renderer.gatesAudio());
  }

  setState(name) {
    this.state = name;
    if (this.renderer) {
      this.renderer.setState(name);
    }
  }

  setLevel(rms, zcr, active) {
    if (this.renderer) {
      this.renderer.setLevel(rms, zcr, active);
    }
  }

  // Raw reply audio, not just its envelope. Only the MuseTalk renderer uses
  // it; the others ignore it through the base class.
  pushAudio(pcmBytes) {
    if (this.renderer) {
      this.renderer.pushAudio(pcmBytes);
    }
  }

  setAudioPosition(played, active) {
    if (this.renderer) {
      this.renderer.setAudioPosition(played, active);
    }
  }

  beginReplay() {
    return !!(this.renderer && this.renderer.beginReplay());
  }

  endTurn() {
    if (this.renderer) {
      this.renderer.endTurn();
    }
  }

  silence() {
    if (this.renderer) {
      this.renderer.silence();
    }
  }
}

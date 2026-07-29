// Head close-up.
//
// The main stage shows the whole figure; this crops the head out of whatever
// the active renderer already drew and blows it up in a floating frame, so the
// mouth stays readable while the body has room to move.
//
// Done by copying pixels rather than rendering a second time. A second camera
// would mean a second draw pass for the 3D renderer, a second model instance
// for Live2D, and would not work at all for video - and none of them would
// share this one implementation.
//
// The frame can be dragged anywhere and resized from its corner. Where it
// belongs depends on the model, the framing and what the user is doing, none
// of which this code can know, so it is placed by hand and remembered.

import { setting } from "./settings.js";

// Where to look when the renderer cannot say. Most framings put the head in
// the upper middle, so this is a reasonable miss rather than a random one.
const DEFAULT_RECT = { x: 0.5, y: 0.24, w: 0.34, h: 0.34 };

const STORAGE_KEY = "mate.inset.box";

// Below the minimum a face is too small to read a mouth shape in, which is the
// entire point of the frame. Above the maximum it stops being an inset and
// starts being a second stage covering the first.
const MIN_SIZE = 120;
const MAX_SIZE = 520;
// However large the window is, the frame should not swallow the picture.
const MAX_FRACTION = 0.6;

const DEFAULT_BOX = { x: 24, y: 62, size: 200 };

function clamp(value, low, high) {
  return Math.max(low, Math.min(value, high));
}

export class HeadInset {
  constructor(frame, canvas) {
    this.frame = frame;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.stage = null;
    this.running = false;
    // Smoothed so the crop glides with the head instead of jittering frame to
    // frame with the projection.
    this.rect = Object.assign({}, DEFAULT_RECT);

    this.box = this._restore();
    this._applyBox();

    this._onResize = () => this._applyBox();
    window.addEventListener("resize", this._onResize);
    this._bindDrag();
  }

  attach(stage) {
    this.stage = stage;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    const loop = () => {
      this._draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- placement ----------

  _bounds() {
    const parent = this.frame.parentElement;
    return {
      width: (parent && parent.clientWidth) || window.innerWidth,
      height: (parent && parent.clientHeight) || window.innerHeight,
    };
  }

  _restore() {
    try {
      const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
      if (stored && typeof stored.x === "number" && typeof stored.size === "number") {
        return { x: stored.x, y: stored.y, size: stored.size };
      }
    } catch (err) {
      // Corrupt or absent; the default placement is fine.
    }
    return Object.assign({}, DEFAULT_BOX);
  }

  _save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.box));
    } catch (err) {
      // Private mode, or the quota is full. The frame still works this session.
    }
  }

  // Applied on every resize as well as every move: a window that shrank since
  // last time would otherwise restore the frame off-screen, where it cannot be
  // dragged back.
  _applyBox() {
    const bounds = this._bounds();
    const room = Math.min(bounds.width, bounds.height) * MAX_FRACTION;
    const limit = Math.max(MIN_SIZE, Math.min(MAX_SIZE, room));

    this.box.size = clamp(this.box.size, MIN_SIZE, limit);
    this.box.x = clamp(this.box.x, 0, Math.max(0, bounds.width - this.box.size));
    this.box.y = clamp(this.box.y, 0, Math.max(0, bounds.height - this.box.size));

    this.frame.style.left = this.box.x + "px";
    this.frame.style.top = this.box.y + "px";
    this.frame.style.width = this.box.size + "px";
    this.frame.style.height = this.box.size + "px";
  }

  _bindDrag() {
    const grip = this.frame.querySelector(".inset-grip");
    let mode = null;
    let originX = 0;
    let originY = 0;
    let startBox = null;

    const begin = (event, which) => {
      mode = which;
      originX = event.clientX;
      originY = event.clientY;
      startBox = Object.assign({}, this.box);
      this.frame.dataset.dragging = "true";
      // Capture on the frame for both modes: during a resize the pointer
      // routinely leaves the 22px grip, and without capture the drag would
      // end the moment it did.
      this.frame.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    };

    if (grip) {
      grip.addEventListener("pointerdown", (event) => begin(event, "resize"));
    }
    this.frame.addEventListener("pointerdown", (event) => {
      if (!mode) {
        begin(event, "move");
      }
    });

    this.frame.addEventListener("pointermove", (event) => {
      if (!mode) {
        return;
      }
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      if (mode === "move") {
        this.box.x = startBox.x + dx;
        this.box.y = startBox.y + dy;
      } else {
        // Driven by whichever axis moved further, so a diagonal drag does not
        // fight itself when the pointer strays off the corner.
        this.box.size = startBox.size + (Math.abs(dx) > Math.abs(dy) ? dx : dy);
      }
      this._applyBox();
    });

    const finish = (event) => {
      if (!mode) {
        return;
      }
      mode = null;
      this.frame.dataset.dragging = "false";
      try {
        this.frame.releasePointerCapture(event.pointerId);
      } catch (err) {
        // Already released.
      }
      this._save();
    };
    this.frame.addEventListener("pointerup", finish);
    this.frame.addEventListener("pointercancel", finish);

    // An escape hatch for a frame dragged somewhere unusable, and a way back
    // to a known state without hunting for pixel values.
    this.frame.addEventListener("dblclick", () => {
      this.box = Object.assign({}, DEFAULT_BOX);
      this._applyBox();
      this._save();
    });
  }

  // ---------- drawing ----------

  _sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(this.canvas.clientWidth * dpr);
    const height = Math.round(this.canvas.clientHeight * dpr);
    if (width && height && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  _draw() {
    const renderer = this.stage && this.stage.renderer;
    const enabled = setting("head_inset", true);

    if (!enabled || !renderer) {
      this.frame.hidden = true;
      return;
    }

    const source = renderer.sourceElement ? renderer.sourceElement() : null;
    if (!source) {
      this.frame.hidden = true;
      return;
    }

    // A video that has not decoded a frame yet, or a canvas with no backing
    // size, would draw as a black square.
    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;
    if (!sw || !sh) {
      this.frame.hidden = true;
      return;
    }

    this.frame.hidden = false;
    this._sizeCanvas();

    const target = renderer.headRect ? renderer.headRect() || DEFAULT_RECT : DEFAULT_RECT;
    const blend = 0.18;
    this.rect.x += (target.x - this.rect.x) * blend;
    this.rect.y += (target.y - this.rect.y) * blend;
    this.rect.w += (target.w - this.rect.w) * blend;
    this.rect.h += (target.h - this.rect.h) * blend;

    const zoom = Math.max(1, setting("head_inset_zoom", 2.2));
    // The renderer reports how much of the frame the head occupies; the zoom
    // setting then decides how tightly to crop around it.
    const cropW = Math.min(1, this.rect.w * (3.0 / zoom));
    const cropH = Math.min(1, this.rect.h * (3.0 / zoom));

    let sx = (this.rect.x - cropW / 2) * sw;
    let sy = (this.rect.y - cropH / 2) * sh;
    let cw = cropW * sw;
    let ch = cropH * sh;

    // Keep the crop square so the frame does not stretch faces.
    const side = Math.min(cw, ch);
    sx += (cw - side) / 2;
    sy += (ch - side) / 2;
    cw = side;
    ch = side;

    sx = Math.max(0, Math.min(sx, sw - cw));
    sy = Math.max(0, Math.min(sy, sh - ch));

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    try {
      this.ctx.drawImage(source, sx, sy, cw, ch, 0, 0, this.canvas.width, this.canvas.height);
    } catch (err) {
      // Source not ready this frame; the next one will be.
    }
  }
}

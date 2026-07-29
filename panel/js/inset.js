// Head close-up.
//
// The main stage shows the whole figure; this crops the head out of whatever
// the active renderer already drew and blows it up in the corner, so the
// mouth stays readable while the body has room to move.
//
// Done by copying pixels rather than rendering a second time. A second camera
// would mean a second draw pass for the 3D renderer, a second model instance
// for Live2D, and would not work at all for video - and none of them would
// share this one implementation.

import { setting } from "./settings.js";

// Where to look when the renderer cannot say. Most framings put the head in
// the upper middle, so this is a reasonable miss rather than a random one.
const DEFAULT_RECT = { x: 0.5, y: 0.24, w: 0.34, h: 0.34 };

export class HeadInset {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.stage = null;
    this.running = false;
    // Smoothed so the crop glides with the head instead of jittering frame to
    // frame with the projection.
    this.rect = Object.assign({}, DEFAULT_RECT);
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
      this.canvas.hidden = true;
      return;
    }

    const source = renderer.sourceElement ? renderer.sourceElement() : null;
    if (!source) {
      this.canvas.hidden = true;
      return;
    }

    // A video that has not decoded a frame yet, or a canvas with no backing
    // size, would draw as a black square.
    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;
    if (!sw || !sh) {
      this.canvas.hidden = true;
      return;
    }

    this.canvas.hidden = false;
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

    // Keep the crop square so the round inset does not stretch faces.
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

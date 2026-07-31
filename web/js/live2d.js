// Live2D (Cubism 4) renderer.
//
// The Cubism runtime and pixi-live2d-display ship as UMD bundles that expect
// globals rather than ES modules, so they are injected as <script> tags in
// dependency order instead of imported. They are still loaded from vendor/,
// never a CDN, so the panel keeps working offline.
//
// Loading order matters: Cubism Core, then pixi, then the display plugin,
// which attaches itself to the PIXI global.

const SCRIPTS = [
  "./vendor/live2d/live2dcubismcore.min.js",
  "./vendor/live2d/pixi.min.js",
  "./vendor/live2d/cubism4.min.js",
];

// Cubism's standard mouth parameter. Models can define more (ParamMouthForm),
// but every model has this one.
const MOUTH_PARAM = "ParamMouthOpenY";
const MOUTH_FORM_PARAM = "ParamMouthForm";

const MOUTH_ATTACK = 26.0;
const MOUTH_RELEASE = 11.0;
const PEAK_DECAY_PER_SECOND = 0.4;
const PEAK_FLOOR = 0.02;
const SILENCE_THRESHOLD = 0.012;

let scriptsPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-l2d="' + src + '"]');
    if (existing) {
      resolve();
      return;
    }
    const tag = document.createElement("script");
    tag.src = src;
    tag.async = false;
    tag.dataset.l2d = src;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error("failed to load " + src));
    document.head.appendChild(tag);
  });
}

// Loaded once per page: the runtime registers globals, so a second load would
// be wasted work at best.
function ensureRuntime() {
  if (!scriptsPromise) {
    scriptsPromise = (async () => {
      for (const src of SCRIPTS) {
        await loadScript(src);
      }
      if (!window.PIXI || !window.PIXI.live2d) {
        throw new Error("live2d runtime did not initialise");
      }
    })();
  }
  return scriptsPromise;
}

export class Live2DStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.app = null;
    this.model = null;

    this.peak = PEAK_FLOOR;
    this.mouth = 0;
    this.targetMouth = 0;
    this.form = 0;
    this.targetForm = 0;
    this.lastFrame = performance.now();
    this.disposed = false;

    this.zoom = 1;
    this.offsetY = 0.12;

    this._onResize = this._onResize.bind(this);
    // Set in load(); named here so dispose() before a load is still safe.
    this._observer = null;
  }

  async load(modelPath) {
    await ensureRuntime();
    if (this.disposed) {
      return;
    }

    const PIXI = window.PIXI;
    this.app = new PIXI.Application({
      view: this.canvas,
      resizeTo: this.canvas.parentElement || undefined,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio, 2),
      // Same reason as the 3D renderer: without this the canvas reads back
      // black once the frame has been composited.
      preserveDrawingBuffer: true,
    });

    this.model = await PIXI.live2d.Live2DModel.from(modelPath, {
      // The built-in motion sync would fight the envelope-driven mouth below.
      autoInteract: false,
    });
    if (this.disposed) {
      this.model.destroy();
      return;
    }

    this.app.stage.addChild(this.model);
    this._fit();
    this._bindViewControls();
    window.addEventListener("resize", this._onResize);

    // The stage also changes size without the window doing so - showing or
    // hiding the side panel takes width from it - and PIXI's resizeTo only
    // re-reads its target on a window resize, so neither the renderer nor the
    // figure's placement was updated and the model came out mis-scaled.
    //
    // The parent is watched rather than the canvas: autoDensity means PIXI
    // writes the canvas's own style, so observing that would react to its own
    // output. The parent's size comes from layout alone.
    const box = this.canvas.parentElement;
    this._observer =
      box && typeof ResizeObserver === "function" ? new ResizeObserver(this._onResize) : null;
    if (this._observer) {
      this._observer.observe(box);
    }

    // Drive the mouth every frame, after the model's own update has run so
    // idle motions do not overwrite the value.
    this.app.ticker.add(() => this._tick());
  }

  _onResize() {
    // Two steps, and the first is easy to miss: resizeTo only re-measures on
    // PIXI's own window listener, so a stage that changed for any other
    // reason has to be asked. _fit alone would then re-place the figure
    // inside a renderer that is still the old size.
    if (this.app) {
      this.app.resize();
    }
    this._fit();
  }

  // Fit the whole figure by default; the head close-up covers the mouth, so
  // the main view is free to show the pose.
  _fit() {
    if (!this.model || !this.app) {
      return;
    }
    const width = this.app.renderer.width / this.app.renderer.resolution;
    const height = this.app.renderer.height / this.app.renderer.resolution;
    // Laid out to nothing - hidden, or not measured yet. Scaling to that zero
    // would shrink the figure away, and it would stay away until something
    // else resized; the observer calls back once there is a box.
    if (!width || !height) {
      return;
    }
    const base = height / this.model.internalModel.height;

    this.model.scale.set(base * this.zoom);
    this.model.anchor.set(0.5, 0.5);
    this.model.position.set(width / 2, height * (0.5 + this.offsetY));
  }

  setView(zoom, offsetY) {
    this.zoom = Math.max(0.4, Math.min(6, zoom));
    this.offsetY = Math.max(-0.6, Math.min(0.6, offsetY));
    this._fit();
  }

  // Wheel zooms, drag slides the framing - judged by eye, so adjusted by
  // hand rather than through a numeric field.
  _bindViewControls() {
    const canvas = this.canvas;

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.setView(this.zoom * Math.exp(-event.deltaY * 0.0015), this.offsetY);
        this._notifyView();
      },
      { passive: false }
    );

    let dragging = false;
    let lastY = 0;
    canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!dragging) {
        return;
      }
      const dy = (event.clientY - lastY) / (canvas.clientHeight || 1);
      lastY = event.clientY;
      this.setView(this.zoom, this.offsetY + dy * 0.8);
    });
    const stop = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch (err) {
        // Already released.
      }
      this._notifyView();
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  _notifyView() {
    if (this.onViewChange) {
      this.onViewChange(this.zoom, this.offsetY);
    }
  }

  // Live2D models have no head bone to query, but the model's own bounds and
  // placement are known, and the head reliably sits near the top of them.
  headScreenRect() {
    if (!this.model || !this.app) {
      return null;
    }
    const width = this.app.renderer.width / this.app.renderer.resolution;
    const height = this.app.renderer.height / this.app.renderer.resolution;
    if (!width || !height) {
      return null;
    }
    const modelHeight = this.model.internalModel.height * this.model.scale.y;
    const top = this.model.position.y - modelHeight / 2;
    const headSize = modelHeight * 0.26;

    return {
      x: this.model.position.x / width,
      y: (top + headSize * 0.55) / height,
      w: headSize / width,
      h: headSize / height,
    };
  }

  setEnvelope(rms, zcr, active) {
    if (!active || rms < SILENCE_THRESHOLD) {
      this.targetMouth = 0;
      return;
    }
    if (rms > this.peak) {
      this.peak = rms;
    }
    const normalised = Math.min(1, rms / Math.max(this.peak, PEAK_FLOOR));
    this.targetMouth = Math.pow(normalised, 0.7);

    // Brightness widens the mouth shape, which reads as vowel variation
    // without needing per-phoneme data.
    const brightness = Math.min(1, Math.max(0, (zcr - 0.04) / 0.18));
    this.targetForm = brightness * 2 - 1;
  }

  silence() {
    this.targetMouth = 0;
  }

  // Live2D models ship their own motions grouped in the model3.json. Which
  // groups exist varies per model, so one is picked from whatever is there
  // rather than assuming a naming convention.
  playRandomMotion() {
    if (!this.model) {
      return;
    }
    try {
      const definitions = this.model.internalModel.motionManager.definitions || {};
      const groups = Object.keys(definitions).filter(
        (name) => (definitions[name] || []).length > 0
      );
      if (!groups.length) {
        return;
      }
      // Prefer an idle group when present: the others are usually reactions
      // to being poked and read oddly as a response to speech.
      const idle = groups.find((name) => name.toLowerCase().indexOf("idle") >= 0);
      const group = idle || groups[Math.floor(Math.random() * groups.length)];
      const index = Math.floor(Math.random() * definitions[group].length);
      this.model.motion(group, index);
    } catch (err) {
      // Motion playback is decoration; never let it break a reply.
    }
  }

  _tick() {
    if (!this.model) {
      return;
    }
    const now = performance.now();
    const delta = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    const rate = this.targetMouth > this.mouth ? MOUTH_ATTACK : MOUTH_RELEASE;
    this.mouth += (this.targetMouth - this.mouth) * (1 - Math.exp(-rate * delta));
    this.form += (this.targetForm - this.form) * (1 - Math.exp(-12 * delta));
    this.peak = Math.max(PEAK_FLOOR, this.peak - PEAK_DECAY_PER_SECOND * delta);

    const core = this.model.internalModel.coreModel;
    if (!core || !core.setParameterValueById) {
      return;
    }
    try {
      core.setParameterValueById(MOUTH_PARAM, this.mouth);
      core.setParameterValueById(MOUTH_FORM_PARAM, this.form);
    } catch (err) {
      // Some models omit ParamMouthForm; the open value alone still works.
    }
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener("resize", this._onResize);
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this.model) {
      this.model.destroy();
      this.model = null;
    }
    if (this.app) {
      this.app.destroy(false, { children: true });
      this.app = null;
    }
  }
}

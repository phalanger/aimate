// Audio-reactive orb.
//
// Stands in for the character while there is no avatar. It has to answer one
// question at a glance: is it listening, thinking, or talking? So state is
// carried by colour and motion character, not just by a label.
//
// Canvas 2D rather than WebGL: this is a few hundred vertices a frame, and
// leaving the GPU alone matters when four models are already resident on it.

const POINTS = 160;

// Attack fast, release slow. A symmetric follower makes speech look like
// stuttering; this keeps the motion readable.
const LEVEL_ATTACK = 22.0;
const LEVEL_RELEASE = 6.0;

const PALETTE = {
  idle: { core: [150, 158, 178], glow: [90, 100, 125], amp: 0.16, speed: 0.32 },
  listening: { core: [124, 198, 232], glow: [70, 150, 200], amp: 0.55, speed: 0.9 },
  thinking: { core: [217, 192, 122], glow: [170, 140, 70], amp: 0.3, speed: 1.5 },
  speaking: { core: [232, 165, 152], glow: [200, 110, 95], amp: 0.85, speed: 1.15 },
  error: { core: [232, 139, 139], glow: [170, 80, 80], amp: 0.1, speed: 0.25 },
};

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function rgba(c, alpha) {
  return "rgba(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + "," + alpha + ")";
}

export class Orb {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.state = "idle";
    this.level = 0;
    this.targetLevel = 0;
    this.time = 0;
    this.lastFrame = performance.now();

    // Colours are interpolated rather than switched so a state change reads as
    // a mood shift instead of a flicker.
    this.core = PALETTE.idle.core.slice();
    this.glow = PALETTE.idle.glow.slice();
    this.amp = PALETTE.idle.amp;
    this.speed = PALETTE.idle.speed;

    // Independent harmonic phases keep the outline from looking like a
    // pulsing circle.
    this.phases = [Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28];

    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._onResize();
  }

  _onResize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
  }

  setState(name) {
    if (PALETTE[name]) {
      this.state = name;
    }
  }

  setLevel(value) {
    // Speech RMS rarely exceeds ~0.3, so scale it into a usable range instead
    // of leaving the orb almost still.
    const scaled = Math.min(1, Math.max(0, value * 3.2));
    this.targetLevel = Math.pow(scaled, 0.75);
  }

  silence() {
    this.targetLevel = 0;
  }

  _update(delta) {
    this.time += delta;

    const rate = this.targetLevel > this.level ? LEVEL_ATTACK : LEVEL_RELEASE;
    this.level += (this.targetLevel - this.level) * (1 - Math.exp(-rate * delta));

    const target = PALETTE[this.state] || PALETTE.idle;
    const blend = 1 - Math.exp(-4.0 * delta);
    this.core = mix(this.core, target.core, blend);
    this.glow = mix(this.glow, target.glow, blend);
    this.amp += (target.amp - this.amp) * blend;
    this.speed += (target.speed - this.speed) * blend;

    for (let i = 0; i < this.phases.length; i += 1) {
      this.phases[i] += delta * this.speed * (0.35 + i * 0.22);
    }
  }

  _radiusAt(angle, baseRadius) {
    // Three low harmonics: enough to look organic, few enough to stay smooth.
    const wobble =
      Math.sin(angle * 2 + this.phases[0]) * 0.5 +
      Math.sin(angle * 3 - this.phases[1]) * 0.32 +
      Math.sin(angle * 5 + this.phases[2]) * 0.18;

    const idleBreath = Math.sin(this.time * 0.9) * 0.02;
    const drive = 0.06 + this.level * this.amp;
    return baseRadius * (1 + wobble * drive + idleBreath);
  }

  _draw() {
    const ctx = this.ctx;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const baseRadius = Math.min(this.width, this.height) * 0.16;

    ctx.clearRect(0, 0, this.width, this.height);

    // Outer glow. Grows with level so loud passages bloom.
    const glowRadius = baseRadius * (2.6 + this.level * 1.1);
    const gradient = ctx.createRadialGradient(cx, cy, baseRadius * 0.2, cx, cy, glowRadius);
    gradient.addColorStop(0, rgba(this.glow, 0.3 + this.level * 0.28));
    gradient.addColorStop(0.45, rgba(this.glow, 0.09));
    gradient.addColorStop(1, rgba(this.glow, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    // Expanding halo ring: reads as "sound leaving the orb".
    ctx.beginPath();
    for (let i = 0; i <= POINTS; i += 1) {
      const angle = (i / POINTS) * Math.PI * 2;
      const r = this._radiusAt(angle, baseRadius * (1.55 + this.level * 0.5));
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.strokeStyle = rgba(this.core, 0.16 + this.level * 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();

    // Core blob.
    ctx.beginPath();
    for (let i = 0; i <= POINTS; i += 1) {
      const angle = (i / POINTS) * Math.PI * 2;
      const r = this._radiusAt(angle, baseRadius);
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();

    const fill = ctx.createRadialGradient(cx, cy - baseRadius * 0.3, 0, cx, cy, baseRadius * 1.3);
    fill.addColorStop(0, rgba(this.core, 0.34 + this.level * 0.3));
    fill.addColorStop(1, rgba(this.glow, 0.06));
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.strokeStyle = rgba(this.core, 0.55 + this.level * 0.4);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  start() {
    const loop = () => {
      const now = performance.now();
      const delta = Math.min((now - this.lastFrame) / 1000, 0.1);
      this.lastFrame = now;
      this._update(delta);
      this._draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

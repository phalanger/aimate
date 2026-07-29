import * as THREE from "three";
import { GLTFLoader } from "../vendor/three/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "../vendor/three-vrm/three-vrm.module.js";
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
} from "../vendor/three-vrm/three-vrm-animation.module.js";

// Mouth shapes exposed by the VRM expression spec. The lip-sync blends between
// them rather than driving a single "open" value, which is what keeps speech
// from looking like a hinge flapping.
const VOWELS = ["aa", "ih", "ou", "ee", "oh"];

// Envelope tuning. Speech RMS from the TTS sits well below 1.0, so a fixed
// scale would barely move the mouth. A peak follower adapts to whatever the
// current voice's loudness happens to be.
const PEAK_DECAY_PER_SECOND = 0.4;
const PEAK_FLOOR = 0.02;
const MOUTH_ATTACK = 28.0;
const MOUTH_RELEASE = 12.0;
const SILENCE_THRESHOLD = 0.012;

// Zero-crossing rate range that maps onto the bright/dark vowel axis. Measured
// from Qwen3-TTS output at 16 kHz; outside this range we simply clamp.
const ZCR_DARK = 0.04;
const ZCR_BRIGHT = 0.22;

// A freshly loaded VRM stands in its bind pose - arms straight out. Nothing
// about the format implies a resting pose, so one has to be applied.
//
// The model faces -Z with +Y up, which puts the character's right arm along
// +X. Rotating about Z therefore swings an arm down, in opposite directions
// for the two sides.
const ARM_DOWN = 1.25;
const ELBOW_BEND = 0.12;
const SHOULDER_DROP = 0.06;

const BLINK_INTERVAL_MIN = 2.2;
const BLINK_INTERVAL_MAX = 6.5;
const BLINK_DURATION = 0.12;

export class Avatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.vrm = null;
    this.clock = new THREE.Clock();

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      alpha: true,
      // A WebGL canvas discards its drawing buffer once the frame is
      // composited, so anything reading it afterwards - the head inset copies
      // pixels out of it - gets black. Keeping the buffer costs a little
      // bandwidth and is the only way to sample the canvas out of band.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 1.2, 3.0);

    // The look-at target rides slightly in front of the camera so the eyes meet
    // the viewer instead of focusing behind them.
    this.lookTarget = new THREE.Object3D();
    this.lookTarget.position.copy(this.camera.position);
    this.scene.add(this.lookTarget);

    this._setupLights();

    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    // VRMA is the animation format that goes with VRM. Motions are retargeted
    // onto whatever model is loaded, so one file works across characters.
    this.animationLoader = new GLTFLoader();
    this.animationLoader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    this.mixer = null;
    this.action = null;
    // Parsed clips are kept: with a motion chosen per turn the same few files
    // come back constantly, and re-parsing a vrma each time would stall the
    // frame the reply starts on.
    this.clipCache = new Map();

    // Lip-sync state.
    this.peak = PEAK_FLOOR;
    this.mouthOpen = 0;
    this.targetMouth = 0;
    this.vowelWeights = new Float32Array(VOWELS.length);
    this.vowelTargets = new Float32Array(VOWELS.length);

    // Idle motion state.
    this.timeAlive = 0;
    this.nextBlinkAt = this._randomBlinkDelay();
    this.blinkElapsed = -1;
    this.emotion = "neutral";
    this.emotionWeight = 0;
    this.hasAnimation = false;

    // Framing, adjustable by wheel and drag and remembered per character.
    this.zoom = 1;
    this.offsetY = 0;
    this.modelHeight = 0;
    this.modelCentre = new THREE.Vector3();
    this._bindViewControls();

    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._onResize();
  }

  _setupLights() {
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1.0, 1.6, 1.4);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    rim.position.set(-1.4, 1.2, -1.0);
    this.scene.add(rim);

    const ambient = new THREE.HemisphereLight(0xffffff, 0x3a3a52, 1.1);
    this.scene.add(ambient);
  }

  _onResize() {
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this._applyCamera();
  }

  _randomBlinkDelay() {
    return BLINK_INTERVAL_MIN + Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
  }

  async load(url) {
    const gltf = await this.loader.loadAsync(url);
    const vrm = gltf.userData.vrm;
    if (!vrm) {
      throw new Error("not-a-vrm");
    }

    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }

    // VRM 0.x models face +Z while 1.0 models face -Z; this normalises them so
    // the camera framing below works for either spec version.
    VRMUtils.rotateVRM0(vrm);
    // Merging skeletons cuts draw calls substantially on typical VRoid exports.
    VRMUtils.combineSkeletons(vrm.scene);

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });

    if (vrm.lookAt) {
      vrm.lookAt.target = this.lookTarget;
    }

    this._applyRestPose(vrm);

    this.scene.add(vrm.scene);
    this.vrm = vrm;

    this._frameBody();
    return vrm;
  }

  // Plays a .vrma motion on the current model. Without one the model keeps the
  // rest pose plus the small idle drift, which reads as standing still.
  async loadAnimation(url, options) {
    if (!this.vrm || !url) {
      return false;
    }

    let clip = this.clipCache.get(url);
    if (!clip) {
      const gltf = await this.animationLoader.loadAsync(url);
      const animations = gltf.userData.vrmAnimations;
      if (!animations || !animations.length) {
        return false;
      }
      clip = createVRMAnimationClip(animations[0], this.vrm);
      this.clipCache.set(url, clip);
    }

    if (!this.mixer) {
      this.mixer = new THREE.AnimationMixer(this.vrm.scene);
    }

    const next = this.mixer.clipAction(clip);
    const once = options && options.once;
    if (once) {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }

    // Cross-fade rather than cut: a motion swapped mid-conversation should
    // read as a change of mood, not a glitch.
    if (this.action && this.action !== next) {
      next.reset().play();
      this.action.crossFadeTo(next, 0.35, false);
    } else {
      next.reset().play();
    }
    this.action = next;
    this.hasAnimation = true;
    return true;
  }

  clearAnimation() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
      this.action = null;
      this.clipCache.clear();
    }
    this.hasAnimation = false;
    if (this.vrm) {
      this._applyRestPose(this.vrm);
    }
  }

  // Frames the whole figure. Model proportions vary enough that a fixed
  // camera crops some and strands others, so the framing comes from the
  // model's own bounds. The head close-up covers the mouth, which frees the
  // main view to show what the body is doing.
  _frameBody() {
    if (!this.vrm) {
      return;
    }
    this.vrm.scene.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    if (box.isEmpty()) {
      return;
    }

    const size = new THREE.Vector3();
    const centre = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(centre);

    this.modelHeight = Math.max(size.y, 0.1);
    this.modelCentre = centre;
    this._applyCamera();
  }

  // Distance needed to fit the model's height in view, then scaled by the
  // user's zoom. Kept separate from _frameBody so wheel and drag can re-apply
  // it without recomputing the bounds every frame.
  _applyCamera() {
    if (!this.modelHeight) {
      return;
    }
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = this.modelHeight / 2 / Math.tan(fov / 2);
    const distance = (fit * 1.15) / this.zoom;

    const target = this.modelCentre.y + this.offsetY * this.modelHeight;
    this.camera.position.set(0, target, distance);
    this.camera.lookAt(0, target, 0);
    this.lookTarget.position.set(0, target + this.modelHeight * 0.35, distance);
  }

  setView(zoom, offsetY) {
    this.zoom = Math.max(0.4, Math.min(6, zoom));
    this.offsetY = Math.max(-0.6, Math.min(0.6, offsetY));
    this._applyCamera();
  }

  // Wheel zooms, drag slides the framing up and down. Direct manipulation
  // beats a pair of numbers in a settings screen for something you judge by
  // eye.
  _bindViewControls() {
    const canvas = this.canvas;

    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * 0.0015);
        this.setView(this.zoom * factor, this.offsetY);
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
        // Pointer already released.
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

  // Where the head sits in the rendered frame, as normalised coordinates.
  // Projected from the bone so the crop tracks the model instead of assuming
  // a framing that only holds for one rig.
  headScreenRect() {
    if (!this.vrm || !this.vrm.humanoid) {
      return null;
    }
    const head = this.vrm.humanoid.getRawBoneNode("head");
    if (!head) {
      return null;
    }
    const world = new THREE.Vector3();
    head.getWorldPosition(world);

    const projected = world.clone().project(this.camera);
    const x = (projected.x + 1) / 2;
    const y = (1 - projected.y) / 2;

    // Head height in world units projected to screen: gives the crop a size
    // that follows the camera distance instead of a fixed guess.
    const above = world.clone().add(new THREE.Vector3(0, 0.16, 0)).project(this.camera);
    const halfHeight = Math.abs(above.y - projected.y) / 2;
    const size = Math.max(0.12, Math.min(0.9, halfHeight * 2));

    return { x: x, y: y, w: size, h: size };
  }

  setEmotion(name) {
    this.emotion = name || "neutral";
  }

  // Called from the playback worklet's envelope messages.
  setEnvelope(rms, zcr, active) {
    if (!active || rms < SILENCE_THRESHOLD) {
      this.targetMouth = 0;
      return;
    }

    if (rms > this.peak) {
      this.peak = rms;
    }

    const normalised = Math.min(1, rms / Math.max(this.peak, PEAK_FLOOR));
    // A slight curve keeps quiet passages from looking like a closed mouth
    // while stopping loud ones from pinning fully open.
    this.targetMouth = Math.pow(normalised, 0.7);

    const brightness = Math.min(1, Math.max(0, (zcr - ZCR_DARK) / (ZCR_BRIGHT - ZCR_DARK)));
    this._distributeVowels(brightness);
  }

  // Map a single brightness scalar onto the five vowel shapes: dark end favours
  // rounded shapes (ou/oh), bright end favours spread ones (ee/ih), with the
  // neutral "aa" carrying the middle.
  _distributeVowels(brightness) {
    const t = brightness;
    this.vowelTargets[0] = Math.max(0, 1 - Math.abs(t - 0.45) * 2.6); // aa
    this.vowelTargets[1] = Math.max(0, 1 - Math.abs(t - 0.72) * 3.0); // ih
    this.vowelTargets[2] = Math.max(0, 1 - Math.abs(t - 0.12) * 3.2); // ou
    this.vowelTargets[3] = Math.max(0, 1 - Math.abs(t - 0.92) * 3.0); // ee
    this.vowelTargets[4] = Math.max(0, 1 - Math.abs(t - 0.28) * 3.0); // oh

    let sum = 0;
    for (let i = 0; i < this.vowelTargets.length; i += 1) {
      sum += this.vowelTargets[i];
    }
    if (sum <= 0) {
      this.vowelTargets[0] = 1;
      sum = 1;
    }
    for (let i = 0; i < this.vowelTargets.length; i += 1) {
      this.vowelTargets[i] /= sum;
    }
  }

  silence() {
    this.targetMouth = 0;
  }

  _updateLipSync(delta) {
    const rate = this.targetMouth > this.mouthOpen ? MOUTH_ATTACK : MOUTH_RELEASE;
    const blend = 1 - Math.exp(-rate * delta);
    this.mouthOpen += (this.targetMouth - this.mouthOpen) * blend;

    const vowelBlend = 1 - Math.exp(-18.0 * delta);
    for (let i = 0; i < this.vowelWeights.length; i += 1) {
      this.vowelWeights[i] += (this.vowelTargets[i] - this.vowelWeights[i]) * vowelBlend;
    }

    this.peak = Math.max(PEAK_FLOOR, this.peak - PEAK_DECAY_PER_SECOND * delta);

    const expressions = this.vrm.expressionManager;
    if (!expressions) {
      return;
    }
    for (let i = 0; i < VOWELS.length; i += 1) {
      expressions.setValue(VOWELS[i], this.vowelWeights[i] * this.mouthOpen);
    }
  }

  _updateBlink(delta) {
    const expressions = this.vrm.expressionManager;
    if (!expressions) {
      return;
    }

    if (this.blinkElapsed >= 0) {
      this.blinkElapsed += delta;
      const phase = this.blinkElapsed / BLINK_DURATION;
      if (phase >= 1) {
        this.blinkElapsed = -1;
        expressions.setValue("blink", 0);
      } else {
        // Symmetric close/open so the lid does not snap back.
        expressions.setValue("blink", Math.sin(phase * Math.PI));
      }
      return;
    }

    this.nextBlinkAt -= delta;
    if (this.nextBlinkAt <= 0) {
      this.blinkElapsed = 0;
      this.nextBlinkAt = this._randomBlinkDelay();
    }
  }

  _updateEmotion(delta) {
    const expressions = this.vrm.expressionManager;
    if (!expressions) {
      return;
    }
    const known = ["happy", "sad", "angry", "relaxed", "surprised"];
    const blend = 1 - Math.exp(-6.0 * delta);
    const wanted = known.indexOf(this.emotion) >= 0 ? 0.65 : 0;
    this.emotionWeight += (wanted - this.emotionWeight) * blend;

    for (let i = 0; i < known.length; i += 1) {
      const value = known[i] === this.emotion ? this.emotionWeight : 0;
      expressions.setValue(known[i], value);
    }
  }

  // Brings the arms down out of the bind pose into something that reads as
  // standing rather than being measured for a suit.
  _applyRestPose(vrm) {
    if (!vrm.humanoid) {
      return;
    }
    const set = (name, x, y, z) => {
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      if (bone) {
        bone.rotation.set(x, y, z);
      }
    };

    set("leftUpperArm", 0, 0, ARM_DOWN);
    set("rightUpperArm", 0, 0, -ARM_DOWN);
    set("leftLowerArm", 0, ELBOW_BEND, 0);
    set("rightLowerArm", 0, -ELBOW_BEND, 0);
    set("leftShoulder", 0, 0, SHOULDER_DROP);
    set("rightShoulder", 0, 0, -SHOULDER_DROP);
  }

  // Without idle motion a VRM reads as a mannequin the moment it stops talking,
  // so the head and chest keep drifting on layered sine waves.
  _updateIdleMotion() {
    if (!this.vrm.humanoid) {
      return;
    }
    const t = this.timeAlive;

    const head = this.vrm.humanoid.getNormalizedBoneNode("head");
    if (head) {
      head.rotation.y = Math.sin(t * 0.31) * 0.055 + Math.sin(t * 0.13) * 0.03;
      head.rotation.x = Math.sin(t * 0.24) * 0.03;
      head.rotation.z = Math.sin(t * 0.19) * 0.022;
    }

    const chest = this.vrm.humanoid.getNormalizedBoneNode("chest");
    if (chest) {
      const breath = Math.sin(t * 1.15);
      chest.rotation.x = breath * 0.018;
    }

    const spine = this.vrm.humanoid.getNormalizedBoneNode("spine");
    if (spine) {
      spine.rotation.y = Math.sin(t * 0.21) * 0.018;
    }

    // Arms drift around the rest pose rather than hanging rigid. Written as
    // an offset from ARM_DOWN so the pose stays the anchor.
    const sway = Math.sin(t * 0.43) * 0.03;
    const breathe = Math.sin(t * 1.15) * 0.012;

    const leftArm = this.vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
    if (leftArm) {
      leftArm.rotation.z = ARM_DOWN + sway + breathe;
    }
    const rightArm = this.vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    if (rightArm) {
      rightArm.rotation.z = -ARM_DOWN - sway - breathe;
    }
  }

  update() {
    const delta = this.clock.getDelta();
    this.timeAlive += delta;

    if (this.vrm) {
      if (this.mixer) {
        this.mixer.update(delta);
      } else {
        // The procedural idle only runs when no clip is playing; both writing
        // to the same bones would fight, and the clip should win.
        this._updateIdleMotion();
      }
      this._updateLipSync(delta);
      this._updateBlink(delta);
      this._updateEmotion(delta);
      // vrm.update applies expression values and runs spring bones, so every
      // setValue above has to happen before this call.
      this.vrm.update(delta);
    }

    this.renderer.render(this.scene, this.camera);
  }

  start() {
    const loop = () => {
      this.update();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

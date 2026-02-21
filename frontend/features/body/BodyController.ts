// features/body/BodyController.ts
import { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { LiveContextController } from "../live/LiveContextController";

// ============================================================================
// BIOMECHANICAL CONSTANTS
// ============================================================================
const BIO = {
  BASE_BREATH_RATE: 0.3,
  ENERGY_BREATH_MOD: 0.35,
  SPEAKING_BREATH_MOD: 0.5,
  BREATH_AMPLITUDE: 0.025,
  BREATH_SMOOTH: 0.08,

  BASE_SWAY_FREQ: 0.18,
  ENERGY_SWAY_MOD: 0.25,
  SPEAKING_SWAY_MOD: 0.4,
  SWAY_AMPLITUDE: 0.04,
  IDLE_SMOOTH: 0.12,

  // Emotion → spine mapping (subtle, realistic values)
  HAPPY_SPINE: 0.08,
  SAD_SPINE: -0.12,
  ANGRY_SPINE: -0.06,
  SURPRISED_SPINE: 0.1,
  NEUTRAL_SPINE: 0.02,
  POSE_SMOOTH: 0.18,

  // Arm transition speed (radians per second)
  ARM_TRANSITION_SPEED: 2.5,
};

// 🧠 REALISTIC HUMAN HABITS
// VRM Standard Coordinate System:
// - Left Arm: +Z rotation = arm DOWN, -Z = arm UP
// - Right Arm: -Z rotation = arm DOWN, +Z = arm UP
// - X (Pitch): Forward/Back movement
// - Y (Yaw): Twist
// Format: [Pitch (X), Yaw (Y), Roll (Z)] in Radians
const HABITS = {
  REST: {
    // Arms naturally at sides, slight elbow bend
    lUp: [0.05, 0, 1.4], lLow: [-0.15, 0, 0],
    rUp: [0.05, 0, -1.4], rLow: [-0.15, 0, 0]
  },
  THINKING_CHIN: {
    // Right hand to chin, left arm relaxed
    lUp: [0.05, 0, 1.4], lLow: [-0.15, 0, 0],
    rUp: [-0.8, -0.3, -0.6], rLow: [-1.6, 0, 0]
  },
  HAIR_TUCK: {
    // Left hand to ear
    lUp: [-0.5, 0.4, 0.9], lLow: [-1.8, 0, 0],
    rUp: [0.05, 0, -1.4], rLow: [-0.15, 0, 0]
  },
  EXPLAIN_OPEN: {
    // Both hands forward, palms up (speaking gesture)
    lUp: [-0.3, 0.3, 0.7], lLow: [-0.9, 0, 0.15],
    rUp: [-0.3, -0.3, -0.7], rLow: [-0.9, 0, -0.15]
  },
  LISTEN_CLASPED: {
    // Hands together at waist
    lUp: [-0.15, 0.2, 0.5], lLow: [-1.2, 0, 0.1],
    rUp: [-0.15, -0.2, -0.5], rLow: [-1.2, 0, -0.1]
  },
  WAVE_HIGH: {
    // Right hand waving
    lUp: [0.05, 0, 1.4], lLow: [-0.15, 0, 0],
    rUp: [-0.4, 0, -1.0], rLow: [-0.6, 0, -0.3]
  }
};

// ============================================================================
// SMOOTHING UTILS
// ============================================================================
const smooth = (current: number, target: number, smoothTime: number, dt: number): number => {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  return current + (target - current) * (1 - exp);
};

// ============================================================================
// BODY CONTROLLER
// ============================================================================
export class BodyController {
  private vrm: VRM;
  private live: LiveContextController;
  private isEnabled = true;

  private time = 0;
  private state = {
    spineBend: BIO.NEUTRAL_SPINE,
    shoulderHeight: 0,
    breathPhase: 0,
    breathDepth: BIO.BREATH_AMPLITUDE,
    swayPhase: 0,
    swayAmplitude: BIO.SWAY_AMPLITUDE,
    energy: 0.6,
    isUserSpeaking: false,
    isAvatarSpeaking: false,
  };
  private targets = {
    spineBend: BIO.NEUTRAL_SPINE,
    shoulderHeight: 0,
    breathDepth: BIO.BREATH_AMPLITUDE,
    swayAmplitude: BIO.SWAY_AMPLITUDE
  };

  private bones: Record<string, THREE.Object3D | null> = {};
  private restQuats = new Map<string, THREE.Quaternion>();
  private emotionMemory = { happy: 0, sad: 0, angry: 0, surprised: 0 };

  // 🧠 Persona Engine State
  private currentHabit = HABITS.REST;
  private habitTimer = 0;
  private armSmoothState = {
    lUp: [0, 0, 1.4],
    lLow: [0, 0, 0],
    rUp: [0, 0, -1.4],
    rLow: [0, 0, 0]
  };

  private _euler = new THREE.Euler(0, 0, 0, "YXZ");
  private _qTmp = new THREE.Quaternion();
  private _qTarget = new THREE.Quaternion();

  constructor(vrm: VRM, live: LiveContextController) {
    this.vrm = vrm;
    this.live = live;
    this.cacheBones();
    this.forceInitialFacing();
    console.log("✅ BodyController: Persona Engine Online");
  }

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // INITIALIZATION
  // ──────────────────────────────────────────────────────────────────────────
  private cacheBones() {
    const h = this.vrm.humanoid;
    if (!h) return;

    const names = [
      "hips", "spine", "chest", "upperChest",
      "leftShoulder", "rightShoulder",
      "leftUpperArm", "rightUpperArm",
      "leftLowerArm", "rightLowerArm"
    ] as const;

    names.forEach(name => {
      const bone = h.getNormalizedBoneNode(name as any);
      if (bone) {
        this.bones[name] = bone;
        // Store rest quaternion (T-pose or model's default pose)
        this.restQuats.set(name, bone.quaternion.clone());
      }
    });

    // Initialize arm smooth state to REST pose
    this.armSmoothState = {
      lUp: [...HABITS.REST.lUp],
      lLow: [...HABITS.REST.lLow],
      rUp: [...HABITS.REST.rUp],
      rLow: [...HABITS.REST.rLow]
    };
  }

  private forceInitialFacing() {
    // VRM models typically face -Z (away from camera)
    // Flip 180° to face the camera
    if (this.vrm.scene) {
      this.vrm.scene.rotation.y = Math.PI;
    }

    // Reset hips to ensure proper orientation
    const hips = this.bones["hips"];
    if (hips) {
      hips.rotation.set(0, 0, 0);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MAIN UPDATE LOOP
  // ──────────────────────────────────────────────────────────────────────────
  public update(dt: number) {
    if (!this.isEnabled || !this.vrm.humanoid) return;

    this.time += dt;
    const delta = Math.min(dt, 0.1);

    const emotions = this.live.getEmotions();
    const energy = this.live.getEnergy();
    const speaking = this.live.getSpeakingState();
    const gestures = this.live.getGestures();

    // Update state from context
    this.state.energy = smooth(this.state.energy, energy, 0.3, delta);
    this.state.isUserSpeaking = speaking.isUserSpeaking;
    this.state.isAvatarSpeaking = speaking.isAvatarSpeaking;

    // Smooth emotion memory
    this.emotionMemory.happy = smooth(this.emotionMemory.happy, emotions.happy, 0.25, delta);
    this.emotionMemory.sad = smooth(this.emotionMemory.sad, emotions.sad, 0.25, delta);
    this.emotionMemory.angry = smooth(this.emotionMemory.angry, emotions.angry, 0.25, delta);
    this.emotionMemory.surprised = smooth(this.emotionMemory.surprised, emotions.surprised, 0.25, delta);

    // Decision engine for habits
    this.habitTimer -= delta;
    if (this.habitTimer <= 0) {
      this.decideNextHabit(gestures);
    }

    // Compute biomechanical targets
    this.computeTargets(delta);
    this.updateBreathing(delta);
    this.updateIdleSway(delta);

    // Apply all poses
    this.applySpinePose();
    this.applyShoulderPose();
    this.applyArms(delta);

    // Update physics (hair, clothes)
    if (this.vrm.springBoneManager) {
      this.vrm.springBoneManager.update(delta);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // HABIT ENGINE (Contextual Pose Selection)
  // ──────────────────────────────────────────────────────────────────────────
  private decideNextHabit(userGestures: string[]) {
    // 1. MIRRORING: Respond to user waves
    if (userGestures.includes("wave") && Math.random() > 0.4) {
      this.currentHabit = HABITS.WAVE_HIGH;
      this.habitTimer = 2.0;
      return;
    }

    // 2. SPEAKING: Active hand gestures
    if (this.state.isAvatarSpeaking) {
      const r = Math.random();
      if (r < 0.35) this.currentHabit = HABITS.EXPLAIN_OPEN;
      else this.currentHabit = HABITS.REST;
      this.habitTimer = 1.5 + Math.random() * 2.0;
      return;
    }

    // 3. LISTENING: User is talking
    if (this.state.isUserSpeaking) {
      const r = Math.random();
      if (r < 0.25) this.currentHabit = HABITS.THINKING_CHIN;
      else if (r < 0.55) this.currentHabit = HABITS.LISTEN_CLASPED;
      else this.currentHabit = HABITS.REST;
      this.habitTimer = 3.0 + Math.random() * 3.0;
      return;
    }

    // 4. IDLE: Natural resting behavior
    const r = Math.random();
    if (r < 0.15) this.currentHabit = HABITS.HAIR_TUCK;
    else if (r < 0.35) this.currentHabit = HABITS.LISTEN_CLASPED;
    else this.currentHabit = HABITS.REST;
    this.habitTimer = 4.0 + Math.random() * 5.0;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // BIOMECHANICS COMPUTATION
  // ──────────────────────────────────────────────────────────────────────────
  private computeTargets(dt: number) {
    // Spine bend based on emotion
    let targetSpine = BIO.NEUTRAL_SPINE;
    targetSpine += this.emotionMemory.happy * BIO.HAPPY_SPINE;
    targetSpine += this.emotionMemory.sad * BIO.SAD_SPINE;
    targetSpine += this.emotionMemory.angry * BIO.ANGRY_SPINE;
    targetSpine += this.emotionMemory.surprised * BIO.SURPRISED_SPINE;

    // Speaking adjustment (lean forward slightly)
    const speakMod = this.state.isAvatarSpeaking ? 0.3 : (this.state.isUserSpeaking ? 0.1 : 0);
    targetSpine += speakMod * 0.05;

    // Energy multiplier
    targetSpine *= 0.6 + this.state.energy * 0.5;

    // Shoulder height based on emotion
    let targetShoulders = 0;
    targetShoulders += this.emotionMemory.sad * 0.1;
    targetShoulders += this.emotionMemory.surprised * 0.15;
    targetShoulders += this.emotionMemory.angry * 0.08;
    targetShoulders *= 0.6 + this.state.energy * 0.5;
    targetShoulders -= speakMod * 0.03;

    // Clamp to safe ranges
    this.targets.spineBend = THREE.MathUtils.clamp(targetSpine, -0.25, 0.25);
    this.targets.shoulderHeight = THREE.MathUtils.clamp(targetShoulders, -0.08, 0.25);

    // Smooth state transitions
    this.state.spineBend = smooth(this.state.spineBend, this.targets.spineBend, BIO.POSE_SMOOTH, dt);
    this.state.shoulderHeight = smooth(this.state.shoulderHeight, this.targets.shoulderHeight, BIO.POSE_SMOOTH, dt);
  }

  private updateBreathing(dt: number) {
    let rate = BIO.BASE_BREATH_RATE;
    rate += this.state.energy * BIO.ENERGY_BREATH_MOD;
    rate += (this.state.isUserSpeaking || this.state.isAvatarSpeaking) ? BIO.SPEAKING_BREATH_MOD : 0;

    this.state.breathPhase = (this.state.breathPhase + dt * rate) % 1;

    let depth = BIO.BREATH_AMPLITUDE;
    depth += this.state.energy * 0.008;
    depth += (this.state.isUserSpeaking || this.state.isAvatarSpeaking) ? 0.012 : 0;

    this.targets.breathDepth = depth;
    this.state.breathDepth = smooth(this.state.breathDepth, this.targets.breathDepth, BIO.BREATH_SMOOTH, dt);
  }

  private updateIdleSway(dt: number) {
    let freq = BIO.BASE_SWAY_FREQ;
    freq += this.state.energy * BIO.ENERGY_SWAY_MOD;
    freq += this.state.isAvatarSpeaking ? BIO.SPEAKING_SWAY_MOD : 0;

    this.state.swayPhase = (this.state.swayPhase + dt * freq) % (Math.PI * 2);

    let amp = BIO.SWAY_AMPLITUDE;
    amp += this.state.energy * 0.01;
    amp += this.state.isAvatarSpeaking ? 0.015 : 0;

    this.targets.swayAmplitude = amp;
    this.state.swayAmplitude = smooth(this.state.swayAmplitude, this.targets.swayAmplitude, BIO.IDLE_SMOOTH, dt);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POSE APPLICATION
  // ──────────────────────────────────────────────────────────────────────────
  private applySpinePose() {
    const breath = Math.sin(this.state.breathPhase * Math.PI * 2) * this.state.breathDepth;
    const sway = Math.sin(this.state.swayPhase) * this.state.swayAmplitude;
    const total = this.state.spineBend + breath * 0.6;

    ["hips", "spine", "chest", "upperChest"].forEach((name, i) => {
      const bone = this.bones[name];
      const rest = this.restQuats.get(name);
      if (!bone || !rest) return;

      // Upper body moves more than lower body
      const factor = 1 - (i / 3) * 0.6;
      const bend = total * factor;
      const swayX = sway * 0.25 * factor;
      const swayZ = sway * 0.12 * factor;

      this._euler.set(bend, swayX, swayZ, "YXZ");
      this._qTmp.setFromEuler(this._euler);
      this._qTarget.copy(rest).multiply(this._qTmp);

      bone.quaternion.slerp(this._qTarget, BIO.IDLE_SMOOTH);
    });
  }

  private applyShoulderPose() {
    ["leftShoulder", "rightShoulder"].forEach((name, i) => {
      const bone = this.bones[name];
      const rest = this.restQuats.get(name);
      if (!bone || !rest) return;

      // Left = positive, Right = negative for symmetry
      const mult = i === 0 ? 1 : -1;
      this._qTmp.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.state.shoulderHeight * mult * 0.6);
      this._qTarget.copy(rest).multiply(this._qTmp);

      bone.quaternion.slerp(this._qTarget, BIO.IDLE_SMOOTH * 1.2);
    });
  }

  private applyArms(dt: number) {
    // Smooth arm transitions (prevents snapping)
    const lerpSpeed = BIO.ARM_TRANSITION_SPEED * dt;

    const lerpArray = (current: number[], target: number[], speed: number) => {
      return current.map((val, i) => THREE.MathUtils.lerp(val, target[i], speed));
    };

    this.armSmoothState.lUp = lerpArray(this.armSmoothState.lUp, this.currentHabit.lUp, lerpSpeed);
    this.armSmoothState.lLow = lerpArray(this.armSmoothState.lLow, this.currentHabit.lLow, lerpSpeed);
    this.armSmoothState.rUp = lerpArray(this.armSmoothState.rUp, this.currentHabit.rUp, lerpSpeed);
    this.armSmoothState.rLow = lerpArray(this.armSmoothState.rLow, this.currentHabit.rLow, lerpSpeed);

    // Micro-movements (prevents statue effect)
    const microJitter = Math.sin(this.time * 2.5) * 0.015 * this.state.energy;

    const applyBone = (name: string, angles: number[]) => {
      const bone = this.bones[name];
      const rest = this.restQuats.get(name);
      if (!bone || !rest) return;

      // Apply micro-jitter to pitch only (natural tremor)
      this._euler.set(angles[0] + microJitter, angles[1], angles[2], "YXZ");
      this._qTmp.setFromEuler(this._euler);
      this._qTarget.copy(rest).multiply(this._qTmp);

      // Direct copy (smoothing handled by lerpArray above)
      bone.quaternion.copy(this._qTarget);
    };

    applyBone("leftUpperArm", this.armSmoothState.lUp);
    applyBone("leftLowerArm", this.armSmoothState.lLow);
    applyBone("rightUpperArm", this.armSmoothState.rUp);
    applyBone("rightLowerArm", this.armSmoothState.rLow);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ──────────────────────────────────────────────────────────────────────────
  public reset() {
    this.emotionMemory = { happy: 0, sad: 0, angry: 0, surprised: 0 };
    this.currentHabit = HABITS.REST;
    this.armSmoothState = {
      lUp: [...HABITS.REST.lUp],
      lLow: [...HABITS.REST.lLow],
      rUp: [...HABITS.REST.rUp],
      rLow: [...HABITS.REST.rLow]
    };
  }

  public forceHabit(habitName: keyof typeof HABITS) {
    this.currentHabit = HABITS[habitName];
    this.habitTimer = 999; // Hold indefinitely until reset
  }
}
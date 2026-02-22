// features/body/BodyController.ts
import { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { LiveContextController } from "../live/LiveContextController";

// ============================================================================
// BIOMECHANICAL CONSTANTS
// ============================================================================
const BIO = {
  // Breathing
  BASE_BREATH_RATE: 0.25,
  BREATH_AMPLITUDE: 0.015,
  BREATH_SMOOTH: 0.08,

  // Sway & Groove (Hips/Spine)
  BASE_SWAY_FREQ: 0.12, 
  SWAY_AMPLITUDE: 0.04,
  HIP_SWAY_AMPLITUDE: 0.02, 
  IDLE_SMOOTH: 0.08,

  // Posture (Spine Bend Z/X)
  HAPPY_SPINE: 0.06,      // Proud, upright
  SAD_SPINE: -0.12,       // Slouched, defeated
  ANGRY_SPINE: 0.04,      // Tense, leaning forward slightly
  SURPRISED_SPINE: 0.08,  // Jolted upright
  NEUTRAL_SPINE: 0.02,    // Natural slight curve
  
  // Shoulders
  HAPPY_SHOULDER: -0.05,  // Relaxed down
  SAD_SHOULDER: 0.15,     // Hunched up
  ANGRY_SHOULDER: 0.10,   // Tense
  
  POSE_SMOOTH: 0.12,
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
// BODY CONTROLLER (Core & Posture Only)
// ============================================================================
export class BodyController {
  private vrm: VRM;
  private live: LiveContextController;
  private isEnabled = true;

  private time = 0;
  
  // Current animated state
  private state = {
    spineBendX: BIO.NEUTRAL_SPINE, // Forward/Back
    spineBendZ: 0,                 // Left/Right Lean
    shoulderHeight: 0,
    breathPhase: 0,
    swayPhaseX: 0,
    swayPhaseZ: 0,
    energy: 0.6,
  };
  
  // Target state based on emotions
  private targets = {
    spineBendX: BIO.NEUTRAL_SPINE,
    shoulderHeight: 0,
    breathRate: BIO.BASE_BREATH_RATE,
    swayFreqX: BIO.BASE_SWAY_FREQ,
    swayFreqZ: BIO.BASE_SWAY_FREQ * 0.8, // Z sways slightly out of phase with X
    swayAmpX: BIO.SWAY_AMPLITUDE,
    swayAmpZ: BIO.SWAY_AMPLITUDE * 0.5,
  };

  private bones: Record<string, THREE.Object3D | null> = {};
  private restQuats = new Map<string, THREE.Quaternion>();
  private initialHipPos = new THREE.Vector3(); 
  
  // Smoothed emotion scores
  private emotionMemory = { happy: 0, sad: 0, angry: 0, surprised: 0, neutral: 1 };

  private _euler = new THREE.Euler(0, 0, 0, "XYZ");
  private _qTmp = new THREE.Quaternion();
  private _qTarget = new THREE.Quaternion();

  constructor(vrm: VRM, live: LiveContextController) {
    this.vrm = vrm;
    this.live = live;
    this.cacheBones();
    console.log("✅ BodyController: Core Posture Engine Online");
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

    // ⚡ STRIPPED OUT ALL ARM BONES. This controller only owns the core.
    const names = [
      "hips", "spine", "chest", "upperChest",
      "leftShoulder", "rightShoulder"
    ] as const;

    names.forEach(name => {
      const bone = h.getNormalizedBoneNode(name as any);
      if (bone) {
        this.bones[name] = bone;
        this.restQuats.set(name, bone.quaternion.clone());
        
        if (name === "hips") {
            this.initialHipPos.copy(bone.position);
        }
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MAIN UPDATE LOOP
  // ──────────────────────────────────────────────────────────────────────────
  public update(dt: number) {
    if (!this.isEnabled || !this.vrm.humanoid) return;

    this.time += dt;
    const delta = Math.min(dt, 0.1);

    // 1. Gather Context
    const emotions = this.live.getEmotions();
    const energy = this.live.getEnergy();
    const speaking = this.live.getSpeakingState();

    // 2. Smooth Context into Memory
    this.state.energy = smooth(this.state.energy, energy, 0.3, delta);
    this.emotionMemory.happy = smooth(this.emotionMemory.happy, emotions.happy || 0, 0.3, delta);
    this.emotionMemory.sad = smooth(this.emotionMemory.sad, emotions.sad || 0, 0.3, delta);
    this.emotionMemory.angry = smooth(this.emotionMemory.angry, emotions.angry || 0, 0.3, delta);
    this.emotionMemory.surprised = smooth(this.emotionMemory.surprised, emotions.surprised || 0, 0.3, delta);
    this.emotionMemory.neutral = smooth(this.emotionMemory.neutral, emotions.neutral || 0, 0.3, delta);

    // 3. Compute Biomechanics based on emotion blend
    this.computeEmotionalTargets(speaking.isAvatarSpeaking, speaking.isUserSpeaking);
    
    // 4. Update Oscillators (Breathing, Swaying)
    this.updateOscillators(delta);

    // 5. Apply to Skeleton
    this.applyCorePosture();
    this.applyShoulders();

    if (this.vrm.springBoneManager) {
      this.vrm.springBoneManager.update(delta);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // EMOTIONAL GROOVE ENGINE
  // ──────────────────────────────────────────────────────────────────────────
  private computeEmotionalTargets(isAvatarSpeaking: boolean, isUserSpeaking: boolean) {
    // --- POSTURE (Spine Bend) ---
    let targetSpineX = BIO.NEUTRAL_SPINE;
    targetSpineX += this.emotionMemory.happy * BIO.HAPPY_SPINE;
    targetSpineX += this.emotionMemory.sad * BIO.SAD_SPINE;
    targetSpineX += this.emotionMemory.angry * BIO.ANGRY_SPINE;
    targetSpineX += this.emotionMemory.surprised * BIO.SURPRISED_SPINE;

    // Lean in slightly when engaged
    if (isAvatarSpeaking) targetSpineX += 0.05;
    else if (isUserSpeaking) targetSpineX += 0.03;

    // --- SHOULDERS ---
    let targetShoulders = 0;
    targetShoulders += this.emotionMemory.happy * BIO.HAPPY_SHOULDER;
    targetShoulders += this.emotionMemory.sad * BIO.SAD_SHOULDER;
    targetShoulders += this.emotionMemory.angry * BIO.ANGRY_SHOULDER;

    // --- DYNAMICS (Sway Speed and Size) ---
    // Base dynamics
    let breathRate = BIO.BASE_BREATH_RATE;
    let swayFreqX = BIO.BASE_SWAY_FREQ;
    let swayAmpX = BIO.SWAY_AMPLITUDE;

    // Emotion: Happy (Bouncy, faster, wider sways)
    if (this.emotionMemory.happy > 0.3) {
        const happyBoost = this.emotionMemory.happy;
        swayFreqX += 0.15 * happyBoost;
        swayAmpX += 0.04 * happyBoost; 
        breathRate += 0.1 * happyBoost;
    }

    // Emotion: Sad (Slow, shallow, heavy)
    if (this.emotionMemory.sad > 0.3) {
        const sadBoost = this.emotionMemory.sad;
        swayFreqX *= (1.0 - (0.5 * sadBoost)); // Slow down drastically
        swayAmpX *= (1.0 - (0.4 * sadBoost));  // Barely move
        breathRate -= 0.05 * sadBoost;         // Shallow breathing
    }

    // Energy Modifiers
    swayFreqX += this.state.energy * 0.1;
    swayAmpX += this.state.energy * 0.02;

    if (isAvatarSpeaking) {
        swayFreqX += 0.05;
        swayAmpX += 0.01;
    }

    // Assign to targets
    this.targets.spineBendX = THREE.MathUtils.clamp(targetSpineX, -0.2, 0.2);
    this.targets.shoulderHeight = THREE.MathUtils.clamp(targetShoulders, -0.1, 0.2);
    this.targets.breathRate = Math.max(0.1, breathRate);
    this.targets.swayFreqX = Math.max(0.05, swayFreqX);
    this.targets.swayAmpX = swayAmpX;

    // Smooth transitions
    this.state.spineBendX = smooth(this.state.spineBendX, this.targets.spineBendX, BIO.POSE_SMOOTH, 0.1);
    this.state.shoulderHeight = smooth(this.state.shoulderHeight, this.targets.shoulderHeight, BIO.POSE_SMOOTH, 0.1);
  }

  private updateOscillators(dt: number) {
    this.state.breathPhase = (this.state.breathPhase + dt * this.targets.breathRate) % 1;
    
    // X Sway (Side to side)
    this.state.swayPhaseX = (this.state.swayPhaseX + dt * this.targets.swayFreqX) % (Math.PI * 2);
    
    // Z Sway (Front to back - slightly out of phase for organic feel)
    const zFreq = this.targets.swayFreqX * 0.85; 
    this.state.swayPhaseZ = (this.state.swayPhaseZ + dt * zFreq) % (Math.PI * 2);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POSE APPLICATION
  // ──────────────────────────────────────────────────────────────────────────
  private applyCorePosture() {
    // 1. Calculate current procedural offsets
    const breathOffset = Math.sin(this.state.breathPhase * Math.PI * 2) * BIO.BREATH_AMPLITUDE;
    
    // Lateral sway (side-to-side)
    const swayX = Math.sin(this.state.swayPhaseX) * this.targets.swayAmpX;
    
    // Depth sway (forward-back)
    const swayZ = Math.cos(this.state.swayPhaseZ) * (this.targets.swayAmpX * 0.5);

    const totalPitch = this.state.spineBendX + breathOffset + swayZ;

    // 2. Weight Shifting (Hips)
    // When upper body sways right (+X), hips shift left (-X) to keep balance
    const hips = this.bones["hips"];
    if (hips) {
        const hipShiftX = -swayX * 0.5; 
        
        // Gentle bounce on the down-beats of the sway
        const bouncePhase = this.state.swayPhaseX * 2; 
        const hipBounceY = -Math.abs(Math.sin(bouncePhase)) * BIO.HIP_SWAY_AMPLITUDE; 
        
        // If sad, drop the hips slightly overall
        const sadDrop = this.emotionMemory.sad * -0.03;

        hips.position.set(
            this.initialHipPos.x + hipShiftX,
            this.initialHipPos.y + hipBounceY + sadDrop,
            this.initialHipPos.z
        );
    }

    // 3. Apply to Spine Chain
    ["spine", "chest", "upperChest"].forEach((name, i) => {
      const bone = this.bones[name];
      const rest = this.restQuats.get(name);
      if (!bone || !rest) return;

      // Distribute the bend across the spine (higher bones bend more)
      const factor = 1 - (i / 3) * 0.5;
      
      const pitch = totalPitch * factor; // Forward/Back
      const roll = swayX * 0.4 * factor; // Left/Right tilt
      const yaw = swayX * 0.2 * factor;  // Slight twist into the sway

      this._euler.set(pitch, yaw, roll, "XYZ");
      this._qTmp.setFromEuler(this._euler);
      this._qTarget.copy(rest).multiply(this._qTmp);

      bone.quaternion.slerp(this._qTarget, BIO.IDLE_SMOOTH);
    });
  }

  private applyShoulders() {
    ["leftShoulder", "rightShoulder"].forEach((name, i) => {
      const bone = this.bones[name];
      const rest = this.restQuats.get(name);
      if (!bone || !rest) return;

      // Left shoulder is positive Z, Right shoulder is negative Z to raise them
      const mult = i === 0 ? 1 : -1;
      
      // Add a tiny bit of breathing lift to the shoulders
      const breathLift = Math.max(0, Math.sin(this.state.breathPhase * Math.PI * 2)) * 0.02;

      this._qTmp.setFromAxisAngle(new THREE.Vector3(0, 0, 1), (this.state.shoulderHeight + breathLift) * mult);
      this._qTarget.copy(rest).multiply(this._qTmp);

      bone.quaternion.slerp(this._qTarget, BIO.IDLE_SMOOTH * 1.5);
    });
  }

  public reset() {
    this.emotionMemory = { happy: 0, sad: 0, angry: 0, surprised: 0, neutral: 1 };
  }
}
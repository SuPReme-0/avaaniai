// features/body/FaceController.ts
import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { LiveContextController } from "../live/LiveContextController";

// ──────────────────────────────────────────────────────────────────────────────
// CONFIGURATION & BIO CONSTANTS
// ──────────────────────────────────────────────────────────────────────────────
const BIO = {
  // Head/Neck Split for Gaze
  NECK_CONTRIBUTION: 0.35,
  HEAD_CONTRIBUTION: 0.55,
  EYE_CONTRIBUTION: 0.9,

  // Blink Dynamics
  BLINK_MIN_INTERVAL: 1.5,
  BLINK_MAX_INTERVAL: 6.0,
  BLINK_DURATION: 0.15,
  BLINK_HOLD: 0.05,
  
  // Emotion
  EMOTION_SMOOTHING: 0.1,
  MAX_EXPRESSION_WEIGHT: 0.85, // Slightly reduced for safety

  // Micro-movements
  IDLE_SWAY_AMOUNT: 0.02,
  IDLE_SWAY_SPEED: 0.5,
  BREATH_AMOUNT: 0.03,
};

// ──────────────────────────────────────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────────────────────────────────────

const damp = (current: number, target: number, lambda: number, dt: number) => {
  return THREE.MathUtils.damp(current, target, lambda, dt);
};

const getBlinkCurve = (phase: number): number => {
  if (phase < 1) {
    return THREE.MathUtils.smoothstep(phase, 0, 1); 
  } else {
    return 1 - THREE.MathUtils.smoothstep(phase - 1, 0, 1);
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// FACE CONTROLLER
// ──────────────────────────────────────────────────────────────────────────────

export class FaceController {
  private vrm: VRM;
  private live: LiveContextController;
  private isEnabled = true;
  private time = 0;

  // ─── STATE: EMOTIONS ───
  private emotionState = {
    happy: 0,
    sad: 0,
    angry: 0,
    surprised: 0,
    neutral: 1,
  };
  private emotionTarget = { ...this.emotionState };

  // ─── STATE: LIPSYNC ───
  private mouthOpen = 0;
  private mouthTarget = 0;
  private visemeRandomizer = 0;

  // ─── STATE: BLINKING ───
  private blinkState = {
    timer: 0,
    nextBlinkTime: 3.0,
    phase: 0,
    isActive: false,
  };
  private blinkOffsetL = 0; 
  private blinkOffsetR = 0;

  // ─── STATE: GAZE ───
  private gaze = {
    x: 0, y: 0,
    tx: 0, ty: 0,
    saccadeX: 0, saccadeY: 0,
    saccadeTimer: 0,
  };
  private lookAtStrength = 1.0;

  // ─── STATE: MICRO MOVEMENTS ───
  private idleSway = 0;
  private breathCycle = 0;

  // ─── BONES & CACHE ───
  private neck: THREE.Object3D | null = null;
  private head: THREE.Object3D | null = null;
  private leftEye: THREE.Object3D | null = null;
  private rightEye: THREE.Object3D | null = null;
  
  private restQuats = {
    neck: new THREE.Quaternion(),
    head: new THREE.Quaternion(),
    leftEye: new THREE.Quaternion(),
    rightEye: new THREE.Quaternion(),
  };

  private _euler = new THREE.Euler(0, 0, 0, "YXZ");
  private _quat = new THREE.Quaternion();

  // ─── TEMP STORAGE ───
  private _blinkValueL = 0;
  private _blinkValueR = 0;
  private _eyeWideFactor = 1.0;

  constructor(vrm: VRM, live: LiveContextController) {
    this.vrm = vrm;
    this.live = live;
    this.cacheBones();
    
    // Initialize random offsets for asymmetry
    this.blinkOffsetL = Math.random() * 0.1;
    this.blinkOffsetR = Math.random() * 0.1;
  }

  private cacheBones() {
    const h = this.vrm.humanoid;
    if (!h) return;
    this.neck = h.getNormalizedBoneNode("neck");
    this.head = h.getNormalizedBoneNode("head");
    this.leftEye = h.getNormalizedBoneNode("leftEye");
    this.rightEye = h.getNormalizedBoneNode("rightEye");

    if (this.neck) this.restQuats.neck.copy(this.neck.quaternion);
    if (this.head) this.restQuats.head.copy(this.head.quaternion);
    if (this.leftEye) this.restQuats.leftEye.copy(this.leftEye.quaternion);
    if (this.rightEye) this.restQuats.rightEye.copy(this.rightEye.quaternion);
  }

  public update(dt: number) {
    if (!this.isEnabled || !this.vrm.humanoid) return;
    
    const safeDt = Math.min(dt, 0.1);
    this.time += safeDt;

    // 📊 GET ALL DATA FROM UNIFIED CONTEXT
    const emotions = this.live.getEmotions();
    const tracking = this.live.getTracking();
    const speakingState = this.live.getSpeakingState();
    const audioVolume = this.live.getAudioVolume(); // ⚡ UNIFIED SOURCE
    const isSpeaking = speakingState?.isAvatarSpeaking ?? false;
    const isUserSpeaking = speakingState?.isUserSpeaking ?? false;
    const attention = this.live.getAttention();
    const engagement = this.live.getEngagement?.() ?? 0.5;

    // 1. UPDATE EMOTIONS (Context Aware)
    this.updateEmotions(emotions, isSpeaking, attention, safeDt);

    // 2. UPDATE LIPSYNC (Using unified volume)
    this.updateLipsync(isSpeaking, audioVolume, safeDt);

    // 3. UPDATE BLINKING (Cognitive Load & Emotion)
    this.updateBlinking(safeDt, engagement);

    // 4. UPDATE GAZE (Attention & Saccades)
    this.updateGaze(tracking, isSpeaking, isUserSpeaking, attention, safeDt);

    // 5. APPLY TRANSFORMS
    this.applyGazeToBones(safeDt);
    this.applyExpressions();
    
    // 6. MICRO MOVEMENTS (Idle)
    this.applyIdleMovement(safeDt);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LOGIC MODULES
  // ──────────────────────────────────────────────────────────────────────────

  private updateEmotions(emotions: any, isSpeaking: boolean, attention: number, dt: number) {
    // Attention affects emotion intensity (low attention = subdued emotions)
    const attentionMod = THREE.MathUtils.mapLinear(attention, 0.3, 1.0, 0.5, 1.0);
    const intensityMod = (isSpeaking ? 0.7 : 1.0) * attentionMod;

    // Target values
    this.emotionTarget.happy = (emotions.happy || 0) * intensityMod;
    this.emotionTarget.sad = (emotions.sad || 0) * intensityMod;
    this.emotionTarget.angry = (emotions.angry || 0) * intensityMod;
    this.emotionTarget.surprised = (emotions.surprised || 0) * intensityMod;
    
    // Normalize emotions to prevent mesh distortion (sum should not exceed 1.0)
    const totalEmotion = 
      this.emotionTarget.happy + 
      this.emotionTarget.sad + 
      this.emotionTarget.angry + 
      this.emotionTarget.surprised;
    
    // If emotions exceed 1.0, normalize them proportionally
    if (totalEmotion > 1.0) {
      const scale = 1.0 / totalEmotion;
      this.emotionTarget.happy *= scale;
      this.emotionTarget.sad *= scale;
      this.emotionTarget.angry *= scale;
      this.emotionTarget.surprised *= scale;
    }
    
    this.emotionTarget.neutral = Math.max(0.1, 1.0 - totalEmotion);

    // Smooth interpolation
    const keys = Object.keys(this.emotionState) as Array<keyof typeof this.emotionState>;
    keys.forEach((key) => {
      this.emotionState[key] = damp(
        this.emotionState[key], 
        this.emotionTarget[key], 
        BIO.EMOTION_SMOOTHING, 
        dt
      );
    });
  }

  private updateLipsync(isSpeaking: boolean, volume: number, dt: number) {
    if (isSpeaking && volume > 0.01) { // Added noise gate
      // Gain: Boost low signals so the mouth actually moves
      // Curve: Pow 0.8 is good, but let's add a linear multiplier
      const sensitivity = 2.2; 
      const shapedVolume = Math.pow(volume, 0.7) * sensitivity; 
      this.mouthTarget = THREE.MathUtils.clamp(shapedVolume, 0, 1.0);

      // Consonants: Viseme randomizer should be faster to feel "clicky"
      this.visemeRandomizer = damp(this.visemeRandomizer, Math.random(), 25, dt);
    } else {
      this.mouthTarget = 0;
      this.visemeRandomizer = damp(this.visemeRandomizer, 0, 15, dt);
    }

    // Jaw physics: Mouths open fast but close with a tiny bit of "drag" for realism
    const lerpSpeed = this.mouthTarget > this.mouthOpen ? 25 : 15;
    this.mouthOpen = damp(this.mouthOpen, this.mouthTarget, lerpSpeed, dt);
  }

  private updateBlinking(dt: number, engagement: number) {
    // Engagement affects blink rate (high engagement = more blinks)
    const engagementFactor = THREE.MathUtils.mapLinear(engagement, 0.2, 1.0, 1.2, 0.8);
    
    const surpriseFactor = this.emotionState.surprised; 
    const calmFactor = 1.0 - (this.emotionState.happy + this.emotionState.angry) * 0.5;
    
    if (!this.blinkState.isActive && this.blinkState.timer >= this.blinkState.nextBlinkTime) {
      this.blinkState.isActive = true;
      this.blinkState.phase = 0;
      
      const baseInterval = THREE.MathUtils.lerp(BIO.BLINK_MIN_INTERVAL, BIO.BLINK_MAX_INTERVAL, Math.random());
      this.blinkState.nextBlinkTime = baseInterval * (1.0 + surpriseFactor * 2.0) * calmFactor * engagementFactor;
      this.blinkState.timer = 0;
    }

    if (this.blinkState.isActive) {
      const speedMod = 1.0 + surpriseFactor * 2.0;
      this.blinkState.phase += dt * (1.0 / BIO.BLINK_DURATION) * speedMod;

      if (this.blinkState.phase >= 2.0) {
        this.blinkState.isActive = false;
        this.blinkState.phase = 0;
      }
    } else {
      this.blinkState.timer += dt;
    }

    const rawBlinkValue = this.blinkState.isActive ? getBlinkCurve(this.blinkState.phase) : 0;
    
    const timeOffset = this.time * 10;
    const asymmetryL = Math.sin(timeOffset + this.blinkOffsetL) * 0.05;
    const asymmetryR = Math.cos(timeOffset + this.blinkOffsetR) * 0.05;

    this._blinkValueL = Math.max(0, Math.min(1, rawBlinkValue + asymmetryL));
    this._blinkValueR = Math.max(0, Math.min(1, rawBlinkValue + asymmetryR));

    this._eyeWideFactor = THREE.MathUtils.lerp(1.0, 0.0, surpriseFactor * 0.5);
  }

  private updateGaze(tracking: any, isSpeaking: boolean, isUserSpeaking: boolean, attention: number, dt: number) {
    let targetX = 0;
    let targetY = 0;

    if (tracking.visible && tracking.x !== undefined && tracking.y !== undefined) {
      targetX = THREE.MathUtils.clamp((tracking.x - 0.5) * 2.5, -1, 1);
      targetY = THREE.MathUtils.clamp((0.5 - tracking.y) * 2.0, -1, 1);
    }

    // Attention affects gaze strength
    const attentionMod = THREE.MathUtils.mapLinear(attention, 0.3, 1.0, 0.5, 1.0);
    
    let attentionModContext = 1.0;
    if (isSpeaking) {
        const thoughtSway = Math.sin(this.time * 0.5) * 0.3; 
        attentionModContext = 0.7 + (thoughtSway * 0.3); 
    } else if (isUserSpeaking) {
        attentionModContext = 1.0;
    }

    this.gaze.tx = targetX * attentionMod * attentionModContext * this.lookAtStrength;
    this.gaze.ty = targetY * attentionMod * attentionModContext * this.lookAtStrength;

    this.gaze.x = damp(this.gaze.x, this.gaze.tx, 5.0, dt);
    this.gaze.y = damp(this.gaze.y, this.gaze.ty, 5.0, dt);

    this.gaze.saccadeTimer -= dt;
    if (this.gaze.saccadeTimer <= 0) {
      this.gaze.saccadeTimer = 0.3 + Math.random() * 0.7;
      this.gaze.saccadeX = (Math.random() - 0.5) * 0.04;
      this.gaze.saccadeY = (Math.random() - 0.5) * 0.04;
    }
    this.gaze.saccadeX = damp(this.gaze.saccadeX, 0, 8.0, dt);
    this.gaze.saccadeY = damp(this.gaze.saccadeY, 0, 8.0, dt);
  }

  private applyGazeToBones(dt: number) {
    if (!this.neck || !this.head || !this.leftEye || !this.rightEye) return;

    const swayX = Math.sin(this.time * BIO.IDLE_SWAY_SPEED) * BIO.IDLE_SWAY_AMOUNT;
    const swayY = Math.cos(this.time * BIO.IDLE_SWAY_SPEED * 0.8) * BIO.IDLE_SWAY_AMOUNT;

    const totalYaw = this.gaze.x + this.gaze.saccadeX + swayX;
    const totalPitch = this.gaze.y + this.gaze.saccadeY + swayY;

    // Neck
    this._euler.set(totalPitch * BIO.NECK_CONTRIBUTION, totalYaw * BIO.NECK_CONTRIBUTION, 0);
    this._quat.setFromEuler(this._euler);
    this.neck.quaternion.copy(this.restQuats.neck).multiply(this._quat);

    // Head
    this._euler.set(totalPitch * BIO.HEAD_CONTRIBUTION, totalYaw * BIO.HEAD_CONTRIBUTION, 0);
    this._quat.setFromEuler(this._euler);
    this.head.quaternion.copy(this.restQuats.head).multiply(this._quat);

    // Eyes
    const eyeYaw = totalYaw * BIO.EYE_CONTRIBUTION;
    const eyePitch = totalPitch * BIO.EYE_CONTRIBUTION;

    this._euler.set(eyePitch, eyeYaw, 0);
    this._quat.setFromEuler(this._euler);
    
    this.leftEye.quaternion.copy(this.restQuats.leftEye).multiply(this._quat);
    this.rightEye.quaternion.copy(this.restQuats.rightEye).multiply(this._quat);
  }

  private applyIdleMovement(dt: number) {
    this.breathCycle += dt * 0.5;
    const breathY = Math.sin(this.breathCycle) * BIO.BREATH_AMOUNT;
    
    if (this.head) {
        this._euler.set(breathY, 0, 0);
        this._quat.setFromEuler(this._euler);
        this.head.quaternion.multiply(this._quat);
    }
  }
private applyExpressions() {
    const em = this.vrm.expressionManager;
    if (!em) return;

    // Internal helper for VRM 0.0 and 1.0 compatibility
    const safeSet = (name: string, val: number) => {
      // VRM 1.0 uses lowercase, VRM 0.0 uses uppercase or camelCase
      const found = em.getExpression(name.toLowerCase()) || em.getExpression(name);
      if (found) em.setValue(name.toLowerCase(), val);
    };

    // 1. Emotions
    safeSet('happy', this.emotionState.happy);
    safeSet('sad', this.emotionState.sad);
    safeSet('angry', this.emotionState.angry);
    safeSet('surprised', this.emotionState.surprised);

    // 2. Blinks 
    // Optimization: If blink is < 0.01, just set to 0 to save processing
    const blinkL = this._blinkValueL > 0.01 ? this._blinkValueL * this._eyeWideFactor : 0;
    const blinkR = this._blinkValueR > 0.01 ? this._blinkValueR * this._eyeWideFactor : 0;
    
    // VRM Standard names
    safeSet('blinkLeft', blinkL);
    safeSet('blinkRight', blinkR);

    // 3. Lipsync (Vowel A is the primary)
    safeSet('aa', this.mouthOpen);
    
    // Viseme blending: Use randomizer to flick 'ih' and 'oh' blendshapes
    // This makes the mouth shape "vibrate" between shapes like a real human
    if (this.mouthOpen > 0.1) {
        const consonant = this.visemeRandomizer * this.mouthOpen;
        safeSet('ih', consonant * 0.3);
        safeSet('oh', consonant * 0.2);
    }

    em.update();
  }

}
// features/body/FaceController.ts
import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { LiveContextController } from "../live/LiveContextController";
import { streamManager } from "@/lib/vrm/streamManager"; // ⚡ DIRECT AUDIO HOOK

// ──────────────────────────────────────────────────────────────────────────────
// CONFIGURATION & BIO CONSTANTS
// ──────────────────────────────────────────────────────────────────────────────
const BIO = {
  // Head/Neck Split
  NECK_CONTRIBUTION: 0.35,
  HEAD_CONTRIBUTION: 0.65,
  EYE_CONTRIBUTION: 0.8,

  // Blink Dynamics
  BLINK_MIN_INTERVAL: 2.0,
  BLINK_MAX_INTERVAL: 6.0,
  BLINK_DURATION: 0.12,

  // Emotion
  EMOTION_SMOOTHING: 8.0, 
  EMOTION_DEADZONE: 0.05, // ⚡ NEW: Ignores AI noise below 5% to stop face jitter

  // Micro-movements
  IDLE_SWAY_AMOUNT: 0.015,
  IDLE_SWAY_SPEED: 0.5,
  BREATH_AMOUNT: 0.02,
};

// Universal VRM Expression Dictionary (Supports VRM 0.0 and 1.0)
const EXPS = {
  HAPPY: ["happy", "joy"],
  SAD: ["sad", "sorrow"],
  ANGRY: ["angry"],
  SURPRISED: ["surprised", "surprise"],
  RELAXED: ["relaxed", "fun"],
  AA: ["aa", "a"],
  IH: ["ih", "i"],
  OH: ["oh", "o"],
  BLINK_L: ["blinkLeft", "blink_l"],
  BLINK_R: ["blinkRight", "blink_r"],
};

// ──────────────────────────────────────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────────────────────────────────────
const damp = (current: number, target: number, lambda: number, dt: number) => {
  return THREE.MathUtils.damp(current, target, lambda, dt);
};

const getBlinkCurve = (phase: number): number => {
  if (phase < 1) return THREE.MathUtils.smoothstep(phase, 0, 1); 
  return 1 - THREE.MathUtils.smoothstep(phase - 1, 0, 1);
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
  private emotionState = { happy: 0, sad: 0, angry: 0, surprised: 0, neutral: 1 };
  private emotionTarget = { ...this.emotionState };

  // ─── STATE: LIPSYNC ───
  private mouthOpen = 0;
  private mouthTarget = 0;
  private prevVolume = 0;
  private visemeIh = 0;
  private visemeOh = 0;

  // ─── STATE: BLINKING ───
  private blinkState = { timer: 0, nextBlinkTime: 3.0, phase: 0, isActive: false };
  private blinkOffsetL = Math.random() * 0.1; 
  private blinkOffsetR = Math.random() * 0.1;

  // ─── STATE: GAZE & CONVERSATION ───
  private gaze = { x: 0, y: 0, tx: 0, ty: 0, saccadeX: 0, saccadeY: 0, saccadeTimer: 0 };
  private thoughtGaze = { x: 0, y: 0, timer: 0 }; 
  
  private headTilt = 0;
  private targetHeadTilt = 0;
  private tiltTimer = 0;

  private headNod = 0;
  private nodTimer = 0;

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

  private _euler = new THREE.Euler(0, 0, 0, "XYZ"); 
  private _quat = new THREE.Quaternion();

  private _blinkValueL = 0;
  private _blinkValueR = 0;

  constructor(vrm: VRM, live: LiveContextController) {
    this.vrm = vrm;
    this.live = live;
    this.cacheBones();
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

    // ⚡ Direct Hardware Audio Hook (Zero Latency Lipsync)
    const rawVolume = streamManager.getCurrentVolume();

    // Context Extraction
    const emotions = this.live.getEmotions();
    const tracking = this.live.getTracking();
    const speakingState = this.live.getSpeakingState();
    
    const isSpeaking = speakingState?.isAvatarSpeaking ?? false;
    const isUserSpeaking = speakingState?.isUserSpeaking ?? false;
    const attention = this.live.getAttention() || 0.5;
    const engagement = this.live.getEngagement?.() ?? 0.5;

    // Run Pipelines
    this.updateEmotions(emotions, isSpeaking, attention, safeDt);
    this.updateLipsync(isSpeaking, rawVolume, safeDt);
    this.updateBlinking(safeDt, engagement);
    this.updateConversationalHead(isSpeaking, isUserSpeaking, engagement, emotions, safeDt);
    this.updateGaze(tracking, isSpeaking, isUserSpeaking, attention, safeDt);
    
    this.applyGazeToBones(safeDt);
    this.applyExpressions();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PIPELINES
  // ──────────────────────────────────────────────────────────────────────────

  private updateEmotions(emotions: any, isSpeaking: boolean, attention: number, dt: number) {
    // Correctly map "surprise" from backend
    let rawSurprise = emotions.surprise || emotions.surprised || 0;
    let rawHappy = emotions.happy || 0;
    let rawSad = emotions.sad || 0;
    let rawAngry = emotions.angry || 0;

    // ⚡ NEW: Emotion Deadzone (Noise Gate)
    // Prevents the face from twitching if the AI is 4% sure you are angry.
    if (rawSurprise < BIO.EMOTION_DEADZONE) rawSurprise = 0;
    if (rawHappy < BIO.EMOTION_DEADZONE) rawHappy = 0;
    if (rawSad < BIO.EMOTION_DEADZONE) rawSad = 0;
    if (rawAngry < BIO.EMOTION_DEADZONE) rawAngry = 0;
    
    const attentionMod = THREE.MathUtils.mapLinear(attention, 0.2, 1.0, 0.6, 1.0);
    const intensityMod = (isSpeaking ? 0.75 : 1.0) * attentionMod; 

    this.emotionTarget.happy = rawHappy * intensityMod;
    this.emotionTarget.sad = rawSad * intensityMod;
    this.emotionTarget.angry = rawAngry * intensityMod;
    this.emotionTarget.surprised = rawSurprise * intensityMod;
    
    const total = this.emotionTarget.happy + this.emotionTarget.sad + this.emotionTarget.angry + this.emotionTarget.surprised;
    if (total > 1.0) {
      const scale = 1.0 / total;
      this.emotionTarget.happy *= scale;
      this.emotionTarget.sad *= scale;
      this.emotionTarget.angry *= scale;
      this.emotionTarget.surprised *= scale;
    }
    this.emotionTarget.neutral = Math.max(0.1, 1.0 - total);

    const keys = Object.keys(this.emotionState) as Array<keyof typeof this.emotionState>;
    keys.forEach((key) => {
      this.emotionState[key] = damp(this.emotionState[key], this.emotionTarget[key], BIO.EMOTION_SMOOTHING, dt);
    });
  }

  private updateLipsync(isSpeaking: boolean, volume: number, dt: number) {
    if (isSpeaking && volume > 0.02) {
      const sensitivity = 2.5; 
      this.mouthTarget = THREE.MathUtils.clamp(Math.pow(volume * sensitivity, 0.8), 0, 1.0);

      const volDelta = volume - this.prevVolume;
      if (volDelta > 0.03) {
          this.visemeIh = Math.min(1.0, this.visemeIh + 0.5);
          this.visemeOh = damp(this.visemeOh, 0, 15, dt);
      } else if (volDelta < -0.03) {
          this.visemeOh = Math.min(1.0, this.visemeOh + 0.4);
          this.visemeIh = damp(this.visemeIh, 0, 15, dt);
      } else {
          this.visemeIh = damp(this.visemeIh, 0, 10, dt);
          this.visemeOh = damp(this.visemeOh, 0, 10, dt);
      }
    } else {
      this.mouthTarget = 0;
      this.visemeIh = damp(this.visemeIh, 0, 15, dt);
      this.visemeOh = damp(this.visemeOh, 0, 15, dt);
    }

    const lerpSpeed = this.mouthTarget > this.mouthOpen ? 35 : 15;
    this.mouthOpen = damp(this.mouthOpen, this.mouthTarget, lerpSpeed, dt);
    this.prevVolume = volume;
  }

  private updateBlinking(dt: number, engagement: number) {
    const engagementFactor = THREE.MathUtils.mapLinear(engagement, 0.2, 1.0, 1.3, 0.7);
    const surpriseFactor = this.emotionState.surprised; 
    
    if (!this.blinkState.isActive && this.blinkState.timer >= this.blinkState.nextBlinkTime) {
      this.blinkState.isActive = true;
      this.blinkState.phase = 0;
      
      const baseInterval = THREE.MathUtils.lerp(BIO.BLINK_MIN_INTERVAL, BIO.BLINK_MAX_INTERVAL, Math.random());
      this.blinkState.nextBlinkTime = baseInterval * (1.0 + surpriseFactor) * engagementFactor;
      this.blinkState.timer = 0;
    }

    if (this.blinkState.isActive) {
      this.blinkState.phase += dt * (1.0 / BIO.BLINK_DURATION);
      if (this.blinkState.phase >= 2.0) {
        this.blinkState.isActive = false;
        this.blinkState.phase = 0;
      }
    } else {
      this.blinkState.timer += dt;
    }

    const rawBlink = this.blinkState.isActive ? getBlinkCurve(this.blinkState.phase) : 0;
    this._blinkValueL = Math.max(0, Math.min(1, rawBlink + Math.sin(this.time * 5 + this.blinkOffsetL) * 0.02));
    this._blinkValueR = Math.max(0, Math.min(1, rawBlink + Math.cos(this.time * 5 + this.blinkOffsetR) * 0.02));
  }

  private updateConversationalHead(isSpeaking: boolean, isUserSpeaking: boolean, engagement: number, emotions: any, dt: number) {
    // Nodding
    this.nodTimer -= dt;
    if (isUserSpeaking && engagement > 0.6 && this.nodTimer <= 0) {
        if (Math.random() > 0.6) {
            this.headNod = 0.15; // Downward pitch
            this.nodTimer = 2.0 + Math.random() * 3.0; 
        } else {
            this.nodTimer = 1.0;
        }
    }
    this.headNod = damp(this.headNod, 0, 5.0, dt);

    // Tilting
    this.tiltTimer -= dt;
    if (isSpeaking && this.tiltTimer <= 0) {
        const amp = 0.08 + (emotions.happy * 0.1);
        this.targetHeadTilt = (Math.random() - 0.5) * amp;
        this.tiltTimer = 1.5 + Math.random() * 2.0;
    } else if (!isSpeaking) {
        this.targetHeadTilt = 0; 
    }
    this.headTilt = damp(this.headTilt, this.targetHeadTilt, 3.0, dt);
  }

  private updateGaze(tracking: any, isSpeaking: boolean, isUserSpeaking: boolean, attention: number, dt: number) {
    let targetX = 0;
    let targetY = 0;

    if (tracking.visible && tracking.x !== undefined && tracking.y !== undefined) {
      // ⚡ FIXED X: Inverted so she mirrors you (you move right, she turns right to look at you)
      targetX = -THREE.MathUtils.clamp((tracking.x - 0.5) * 2.0, -1, 1);
      
      // ⚡ FIXED Y: Normal mapping (you look down, she looks down at you)
      targetY = THREE.MathUtils.clamp((tracking.y - 0.5) * 2.0, -0.8, 0.8);
    }

    this.thoughtGaze.timer -= dt;
    if (isSpeaking && this.thoughtGaze.timer <= 0) {
        if (Math.random() > 0.7) {
            this.thoughtGaze.x = (Math.random() > 0.5 ? 0.4 : -0.4); 
            // ⚡ FIXED: Negative Y is UP in this coordinate space. She now looks up to think!
            this.thoughtGaze.y = -0.3 - (Math.random() * 0.2);         
            this.thoughtGaze.timer = 1.5 + Math.random() * 2.0;     
        } else {
            this.thoughtGaze.timer = 2.0;
        }
    }
    
    if (this.thoughtGaze.timer < 1.0 || isUserSpeaking) {
        this.thoughtGaze.x = damp(this.thoughtGaze.x, 0, 5.0, dt);
        this.thoughtGaze.y = damp(this.thoughtGaze.y, 0, 5.0, dt);
    }

    this.gaze.saccadeTimer -= dt;
    if (this.gaze.saccadeTimer <= 0) {
      this.gaze.saccadeTimer = 0.2 + Math.random() * 0.6;
      this.gaze.saccadeX = (Math.random() - 0.5) * 0.05;
      this.gaze.saccadeY = (Math.random() - 0.5) * 0.05;
    }

    const attentionMod = THREE.MathUtils.mapLinear(attention, 0.2, 1.0, 0.3, 1.0);
    this.gaze.tx = (targetX + this.thoughtGaze.x) * attentionMod;
    this.gaze.ty = (targetY + this.thoughtGaze.y) * attentionMod;

    this.gaze.x = damp(this.gaze.x, this.gaze.tx, 8.0, dt);
    this.gaze.y = damp(this.gaze.y, this.gaze.ty, 8.0, dt);
    this.gaze.saccadeX = damp(this.gaze.saccadeX, 0, 10.0, dt);
    this.gaze.saccadeY = damp(this.gaze.saccadeY, 0, 10.0, dt);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // PHYSICAL APPLICATION
  // ──────────────────────────────────────────────────────────────────────────

  private applyGazeToBones(dt: number) {
    if (!this.neck || !this.head || !this.leftEye || !this.rightEye) return;

    const swayX = Math.sin(this.time * BIO.IDLE_SWAY_SPEED) * BIO.IDLE_SWAY_AMOUNT;
    const swayY = Math.cos(this.time * BIO.IDLE_SWAY_SPEED * 0.8) * BIO.IDLE_SWAY_AMOUNT;

    const totalYaw = this.gaze.x + swayX; 
    
    // Emotion posture (Sad looks down, surprised looks up)
    const emotionPitch = (this.emotionState.sad * 0.15) + (this.emotionState.surprised * -0.1);
    const totalPitch = this.gaze.y + swayY + this.headNod + emotionPitch; 
    
    const totalRoll = this.headTilt;

    this._euler.set(totalPitch * BIO.NECK_CONTRIBUTION, totalYaw * BIO.NECK_CONTRIBUTION, totalRoll * 0.5, "XYZ");
    this._quat.setFromEuler(this._euler);
    this.neck.quaternion.copy(this.restQuats.neck).multiply(this._quat);

    this._euler.set(totalPitch * BIO.HEAD_CONTRIBUTION, totalYaw * BIO.HEAD_CONTRIBUTION, totalRoll, "XYZ");
    this._quat.setFromEuler(this._euler);
    this.head.quaternion.copy(this.restQuats.head).multiply(this._quat);

    const eyeYaw = (totalYaw + this.gaze.saccadeX) * BIO.EYE_CONTRIBUTION;
    const eyePitch = (totalPitch + this.gaze.saccadeY) * BIO.EYE_CONTRIBUTION;

    this._euler.set(eyePitch, eyeYaw, 0, "XYZ");
    this._quat.setFromEuler(this._euler);
    
    this.leftEye.quaternion.copy(this.restQuats.leftEye).multiply(this._quat);
    this.rightEye.quaternion.copy(this.restQuats.rightEye).multiply(this._quat);
  }

  private applyExpressions() {
    const em = this.vrm.expressionManager;
    if (!em) return;

    const safeSet = (names: string[], val: number) => {
        for (const name of names) {
            const found = em.getExpression(name);
            if (found) {
                em.setValue(name, val);
                return;
            }
        }
    };

    // 1. Core Emotions
    safeSet(EXPS.HAPPY, this.emotionState.happy);
    safeSet(EXPS.SAD, this.emotionState.sad);
    safeSet(EXPS.ANGRY, this.emotionState.angry);
    safeSet(EXPS.SURPRISED, this.emotionState.surprised);
    safeSet(EXPS.RELAXED, this.emotionState.neutral * 0.5); 

    // 2. Blinks 
    const eyeWideFactor = THREE.MathUtils.lerp(1.0, 0.0, this.emotionState.surprised * 0.8);
    safeSet(EXPS.BLINK_L, this._blinkValueL > 0.01 ? this._blinkValueL * eyeWideFactor : 0);
    safeSet(EXPS.BLINK_R, this._blinkValueR > 0.01 ? this._blinkValueR * eyeWideFactor : 0);

    // 3. Lipsync / Visemes
    safeSet(EXPS.AA, this.mouthOpen);
    
    if (this.mouthOpen > 0.05) {
        safeSet(EXPS.IH, this.visemeIh * this.mouthOpen);
        safeSet(EXPS.OH, this.visemeOh * this.mouthOpen);
        
        // Organic speaking flavor: Smile slightly when talking if happy
        if (this.emotionState.happy > 0.3) {
            safeSet(EXPS.HAPPY, Math.min(1.0, this.emotionState.happy + (this.mouthOpen * 0.4)));
        }
    }

    em.update();
  }
}
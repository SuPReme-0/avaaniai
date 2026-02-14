import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { emotionPresets, EmotionName } from "../emotions/emotionPresets";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class IdleFaceController {
  private vrm: VRM;
  private elapsed = 0;

  // Emotion State
  private currentEmotion: EmotionName = "neutral";

  // Blink logic
  private nextBlinkTime = 0;
  private blinkPhase = 0; 
  private isBlinking = false;

  // Gaze & Saccades
  private liveGazeStrength = 0;
  private liveTrackingVisible = false;
  private nextSaccadeTime = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private yaw = 0;
  private pitch = 0;

  private rest = new Map<string, THREE.Quaternion>();
  private _euler = new THREE.Euler(0, 0, 0, "XYZ");
  private _qOff = new THREE.Quaternion();

  constructor(vrm: VRM) {
    this.vrm = vrm;
    this.scheduleNextBlink();
    this.scheduleNextSaccade();
    this.cacheRestEyes();
  }

  // New: Sync with AI Backend emotions
  public setEmotion(name: EmotionName) {
    this.currentEmotion = name;
  }

  public setLiveGaze(params: { strength?: number; visible?: boolean }) {
    if (typeof params.strength === "number") this.liveGazeStrength = clamp(params.strength, 0, 1);
    if (typeof params.visible === "boolean") this.liveTrackingVisible = params.visible;
  }

  private scheduleNextBlink() {
    const energy = emotionPresets[this.currentEmotion].energy;
    // Sad = long wait between blinks, Surprised = frequent blinking
    const baseDelay = 4 - (energy * 3); 
    this.nextBlinkTime = this.elapsed + baseDelay + Math.random() * 2;
  }

  private scheduleNextSaccade() {
    const energy = emotionPresets[this.currentEmotion].energy;
    // Higher energy = faster, more erratic eye jumps
    this.nextSaccadeTime = this.elapsed + (0.8 - (energy * 0.6)) + Math.random() * 0.5;

    const range = 0.1 + (energy * 0.1); 
    this.targetYaw = (Math.random() - 0.5) * range;
    this.targetPitch = (Math.random() - 0.5) * (range * 0.7);
  }

  private cacheRestEyes() {
    const humanoid: any = this.vrm.humanoid;
    const leftEye = humanoid?.getNormalizedBoneNode("leftEye");
    const rightEye = humanoid?.getNormalizedBoneNode("rightEye");
    if (leftEye) this.rest.set("leftEye", leftEye.quaternion.clone());
    if (rightEye) this.rest.set("rightEye", rightEye.quaternion.clone());
  }

  private updateExpressions(blinkValue: number) {
    const expressions = this.vrm.expressionManager;
    if (!expressions) return;

    const metrics = emotionPresets[this.currentEmotion];
    
    // 1. Apply Blinking
    // We adjust the "rest" state of the eyelid based on emotion blinkScale
    const baseEyelidDrop = 1.0 - metrics.blinkScale;
    const finalBlink = Math.max(blinkValue, baseEyelidDrop);

    expressions.setValue("blinkLeft", finalBlink);
    expressions.setValue("blinkRight", finalBlink);

    // 2. Apply the actual facial muscles for the emotion
    for (const [key, val] of Object.entries(metrics.expressions)) {
      // Smoothly blend towards the emotion target
      const currentVal = expressions.getValue(key) ?? 0;
      expressions.setValue(key, THREE.MathUtils.lerp(currentVal, val, 0.1));
    }
  }

  public update(dt: number) {
    this.elapsed += dt;
    const energy = emotionPresets[this.currentEmotion].energy;

    // ----- Blink Logic -----
    let blinkValue = 0;
    if (!this.isBlinking && this.elapsed >= this.nextBlinkTime) {
      this.isBlinking = true;
      this.blinkPhase = 0;
    }

    if (this.isBlinking) {
      // Speed of blink is tied to energy (Surprised = fast blink, Sad = slow)
      const blinkSpeed = 10 + (energy * 10);
      this.blinkPhase = Math.min(this.blinkPhase + dt * blinkSpeed, Math.PI);
      blinkValue = Math.sin(this.blinkPhase);

      if (this.blinkPhase >= Math.PI) {
        this.isBlinking = false;
        this.scheduleNextBlink();
      }
    }

    this.updateExpressions(blinkValue);

    // ----- Eye Saccades -----
    const liveActive = this.liveTrackingVisible && this.liveGazeStrength > 0.35;
    if (liveActive) {
      this.applyEyeOffset(0, 0, dt);
    } else {
      if (this.elapsed >= this.nextSaccadeTime) this.scheduleNextSaccade();
      this.applyEyeOffset(this.targetYaw, this.targetPitch, dt);
    }
  }

  private applyEyeOffset(yaw: number, pitch: number, dt: number) {
    const humanoid: any = this.vrm.humanoid;
    const leftEye = humanoid?.getNormalizedBoneNode("leftEye");
    const rightEye = humanoid?.getNormalizedBoneNode("rightEye");
    if (!leftEye || !rightEye) return;

    const baseL = this.rest.get("leftEye")!;
    const baseR = this.rest.get("rightEye")!;

    // Eye follow speed is tied to energy
    const k = 1 - Math.exp(-dt * (10 + emotionPresets[this.currentEmotion].energy * 15));
    this.yaw += (yaw - this.yaw) * k;
    this.pitch += (pitch - this.pitch) * k;

    this._euler.set(this.pitch, this.yaw, 0, "XYZ");
    this._qOff.setFromEuler(this._euler);

    leftEye.quaternion.copy(baseL).multiply(this._qOff);
    rightEye.quaternion.copy(baseR).multiply(this._qOff);
  }
}
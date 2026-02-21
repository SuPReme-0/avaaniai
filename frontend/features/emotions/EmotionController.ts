import type { VRM } from "@pixiv/three-vrm";
import * as THREE from "three";

// Helper: Linear Interpolation
const lerp = (start: number, end: number, t: number) => start * (1 - t) + end * t;

export class EmotionController {
  private vrm: VRM;
  
  // State: We keep track of the current values to smooth them over time
  private current = { happy: 0, sad: 0, angry: 0, surprised: 0 };
  
  // Blink State
  private blinkTimer = 0;
  private blinkValue = 0;
  private isBlinking = false;

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  // --- MAIN UPDATE LOOP ---
  public update(dt: number, emotionTarget: any) {
    // 1. EMOTION SMOOTHING
    // Speed 2.5 = Takes ~0.5s to fully transition emotions.
    // This creates a "Mood" feel rather than a robotic reaction.
    const speed = 2.5 * dt;

    this.current.happy = lerp(this.current.happy, emotionTarget.happy || 0, speed);
    this.current.sad = lerp(this.current.sad, emotionTarget.sad || 0, speed);
    this.current.angry = lerp(this.current.angry, emotionTarget.angry || 0, speed);
    this.current.surprised = lerp(this.current.surprised, emotionTarget.surprise || 0, speed);

    // 2. APPLY EMOTIONS TO MESH
    this.applyEmotions();

    // 3. HANDLE BLINKING
    this.updateBlink(dt);
  }

  private applyEmotions() {
    const em = this.vrm.expressionManager;
    if (!em) return;

    // Apply the smoothed values
    em.setValue("happy", this.current.happy);
    em.setValue("sad", this.current.sad);
    em.setValue("angry", this.current.angry);
    em.setValue("surprised", this.current.surprised);
  }

  private updateBlink(dt: number) {
    // Standard random blink logic
    if (this.isBlinking) {
        // Animate Blink (Sine wave)
        this.blinkValue += dt * 12; // Blink speed
        if (this.blinkValue >= Math.PI) {
            this.blinkValue = 0;
            this.isBlinking = false;
            // Schedule next blink (Random 2s to 6s)
            this.blinkTimer = 2 + Math.random() * 4;
        }
    } else {
        // Countdown
        this.blinkTimer -= dt;
        if (this.blinkTimer <= 0) {
            this.isBlinking = true;
            this.blinkValue = 0;
        }
    }

    // Apply Blink (0 to 1)
    const weight = this.isBlinking ? Math.sin(this.blinkValue) : 0;
    
    // Safety check for different VRM naming conventions
    const em = this.vrm.expressionManager;
    if (em) {
        em.setValue("blink", weight);
        // Fallbacks for non-standard VRMs
        if (!em.getExpression("blink")) {
            em.setValue("blinkLeft", weight);
            em.setValue("blinkRight", weight);
        }
    }
  }
}
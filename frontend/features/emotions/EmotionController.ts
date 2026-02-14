import { VRM } from "@pixiv/three-vrm";
import { EmotionName, emotionPresets } from "./emotionPresets";

export class EmotionController {
  private vrm: VRM;
  private targets: Record<string, number> = {};
  private current: Record<string, number> = {};

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  /**
   * Set by preset name (e.g. 'happy')
   */
  setEmotion(name: EmotionName) {
    this.targets = { ...emotionPresets[name] };
  }

  /**
   * Set by weighted probabilities from Backend (e.g. {happy: 0.8, surprise: 0.2})
   * This creates a much more "alive" mixed-emotion look.
   */
  setWeightedEmotion(probs: Record<string, number>) {
    const newTargets: Record<string, number> = {};
    
    for (const [emo, weight] of Object.entries(probs)) {
      const preset = emotionPresets[emo as EmotionName];
      if (!preset) continue;

      for (const [key, val] of Object.entries(preset)) {
        newTargets[key] = (newTargets[key] || 0) + (val * weight);
      }
    }
    this.targets = newTargets;
  }

  update(dt: number) {
    if (!this.vrm.expressionManager) return;

    const speed = 8; // Slightly faster for micro-expressions
    const k = 1 - Math.exp(-speed * dt);

    // Get all unique keys from current and target to ensure we fade out old emotions
    const allKeys = new Set([...Object.keys(this.current), ...Object.keys(this.targets)]);

    allKeys.forEach(key => {
      const from = this.current[key] ?? 0;
      const to = this.targets[key] ?? 0;
      const next = from + (to - from) * k;
      
      this.current[key] = next;

      // Apply to VRM (Handles standard and capitalized keys)
      this.vrm.expressionManager!.setValue(key, next);
      this.vrm.expressionManager!.setValue(key[0].toUpperCase() + key.slice(1), next);
    });
  }

  blink(value: number) {
    if (!this.vrm.expressionManager) return;
    ["blink", "blinkLeft", "blinkRight"].forEach(key => {
      this.vrm.expressionManager!.setValue(key, value);
    });
  }
}
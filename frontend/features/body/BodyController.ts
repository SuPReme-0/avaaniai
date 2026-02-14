import { VRM } from "@pixiv/three-vrm";
import { emotionPresets, EmotionName } from "../emotions/emotionPresets";

export class BodyController {
  private vrm: VRM;
  private targetWeight = 0;
  private currentWeight = 0;
  private currentEmotion: EmotionName = "neutral";

  constructor(vrm: VRM) {
    this.vrm = vrm;
  }

  public setEmotion(name: EmotionName) {
    this.currentEmotion = name;
  }

  setBodyWeight(value: number) {
    this.targetWeight = Math.max(0, Math.min(1, value));
  }

  update(dt: number) {
    const speed = 3;
    const k = 1 - Math.exp(-speed * dt);
    this.currentWeight += (this.targetWeight - this.currentWeight) * k;

    this.applyDeformation(dt);
  }

  private applyDeformation(dt: number) {
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;

    const metrics = emotionPresets[this.currentEmotion];
    // Emotion-based scaling factors
    // Happy/Surprised = expanded chest. Sad = collapsed/narrow.
    const emotionExpansion = (metrics.energy - 0.5) * 0.05; 
    
    const baseScale = 1 + this.currentWeight * 0.25;

    const bones = {
      hips: humanoid.getNormalizedBoneNode("hips"),
      spine: humanoid.getNormalizedBoneNode("spine"),
      chest: humanoid.getNormalizedBoneNode("chest"),
      neck: humanoid.getNormalizedBoneNode("neck")
    };

    // Hips stay stable based on weight
    if (bones.hips) bones.hips.scale.set(baseScale, 1, baseScale);
    
    // Spine & Chest react to "breath" and emotion
    // If sad (low energy), chest scales down slightly (< 1.0)
    const chestScale = (baseScale * 0.9) + emotionExpansion;
    if (bones.spine) bones.spine.scale.set(baseScale * 0.95, 1, baseScale * 0.95);
    if (bones.chest) bones.chest.scale.set(chestScale, 1, chestScale);
    
    if (bones.neck) bones.neck.scale.set(1 + (this.currentWeight * 0.1), 1, 1 + (this.currentWeight * 0.1));
  }
}
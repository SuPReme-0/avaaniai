import * as THREE from "three";
import { emotionPresets, EmotionName } from "../emotions/emotionPresets";

type PoseConfig = {
  shoulderDown: number;
  shoulderForward: number; 
  armInward: number;       
  armInternalRotation: number;
  elbowBend: number;
  wristBend: number;
};

const DEFAULT_CONFIG: PoseConfig = {
  shoulderDown: 0.85,
  shoulderForward: 0.25,     
  armInward: 0.22,           
  armInternalRotation: 0.52, 
  elbowBend: 0.45,           
  wristBend: 0.15,
};

export class PoseController {
  private vrm: any;
  private currentEmotion: EmotionName = "neutral";
  private isEnabled = true;
  private rest = new Map<string, THREE.Quaternion>();
  private currentConfig: PoseConfig = { ...DEFAULT_CONFIG };

  private _euler = new THREE.Euler();
  private _qOffset = new THREE.Quaternion();

  constructor(vrm: any) {
    this.vrm = vrm;
    this.cacheRestPose();
  }

  public setEmotion(name: EmotionName) {
    this.currentEmotion = name;
  }

  public update(dt: number) {
    if (!this.isEnabled || !this.vrm?.humanoid) return;
    
    this.interpolatePoseConfig(dt);
    this.applyNaturalPose();
  }

  private interpolatePoseConfig(dt: number) {
    const energy = emotionPresets[this.currentEmotion].energy;
    const k = 1 - Math.exp(-4 * dt); // Smooth transition speed

    // Adjusting the pose based on energy levels
    // Sad (low energy) = Shoulders drop more, arms come in
    const targetShoulderDown = energy < 0.4 ? 0.95 : 0.82;
    const targetArmInward = energy < 0.4 ? 0.35 : 0.22;
    // Surprised/Angry (high energy) = Shoulders forward
    const targetShoulderForward = energy > 0.8 ? 0.45 : 0.25;

    this.currentConfig.shoulderDown += (targetShoulderDown - this.currentConfig.shoulderDown) * k;
    this.currentConfig.armInward += (targetArmInward - this.currentConfig.armInward) * k;
    this.currentConfig.shoulderForward += (targetShoulderForward - this.currentConfig.shoulderForward) * k;
  }

  private applyNaturalPose() {
    const humanoid = this.vrm.humanoid;
    const c = this.currentConfig;

    // Apply offsets using the dynamic currentConfig
    this.applyOffset(humanoid, "leftUpperArm", c.shoulderForward, c.armInternalRotation, -c.shoulderDown);
    this.applyOffset(humanoid, "rightUpperArm", c.shoulderForward, -c.armInternalRotation, c.shoulderDown);

    this.applyOffset(humanoid, "leftLowerArm", -c.elbowBend, -c.armInward, 0);
    this.applyOffset(humanoid, "rightLowerArm", -c.elbowBend, c.armInward, 0);

    this.applyOffset(humanoid, "leftHand", 0, 0.3, 0.15);
    this.applyOffset(humanoid, "rightHand", 0, -0.3, -0.15);
  }

  private applyOffset(humanoid: any, name: string, x: number, y: number, z: number) {
    const bone = humanoid.getNormalizedBoneNode(name);
    if (!bone) return;
    if (!this.rest.has(name)) this.rest.set(name, bone.quaternion.clone());

    const base = this.rest.get(name)!;
    this._euler.set(x, y, z, "XYZ");
    this._qOffset.setFromEuler(this._euler);
    bone.quaternion.copy(base).multiply(this._qOffset);
  }

  private cacheRestPose() {
    const humanoid = this.vrm?.humanoid;
    if (!humanoid?.getNormalizedBoneNode) return;
    const bones = ["leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand"];
    bones.forEach(name => {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (bone) this.rest.set(name, bone.quaternion.clone());
    });
  }
}
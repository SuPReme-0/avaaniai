// features/body/HandsController.ts
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { LiveContextController } from "../live/LiveContextController";

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const JOINTS = ["Proximal", "Intermediate", "Distal"];

// Gesture curl presets (0.0 = flat, 1.0 = fully curled)
const GESTURE_CURLS: Record<string, Record<string, number>> = {
  relaxed: { Thumb: 0.15, Index: 0.2, Middle: 0.25, Ring: 0.3, Little: 0.35 },
  open_palm: { Thumb: 0.0, Index: 0.0, Middle: 0.0, Ring: 0.0, Little: 0.0 },
  fist: { Thumb: 0.9, Index: 1.0, Middle: 1.0, Ring: 1.0, Little: 1.0 },
  pointing: { Thumb: 0.7, Index: 0.0, Middle: 0.8, Ring: 0.8, Little: 0.8 },
  peace: { Thumb: 0.7, Index: 0.0, Middle: 0.0, Ring: 0.8, Little: 0.8 },
  thumbs_up: { Thumb: 0.0, Index: 0.9, Middle: 0.9, Ring: 0.9, Little: 0.9 },
};

// ============================================================================
// HAND CONTROLLER (Fingers & Wrists ONLY)
// ============================================================================
export class HandsController {
  private vrm: VRM;
  private live: LiveContextController;

  // 🦴 Finger bone caches
  private leftFingers = new Map<string, THREE.Object3D[]>();
  private rightFingers = new Map<string, THREE.Object3D[]>();
  private restLeftFingers = new Map<string, THREE.Quaternion[]>();
  private restRightFingers = new Map<string, THREE.Quaternion[]>();

  // 🌊 Current smoothed curl values
  private currentCurlsLeft: Record<string, number> = { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 };
  private currentCurlsRight: Record<string, number> = { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 };

  private time = 0;
  private currentGestureLeft = "relaxed";
  private currentGestureRight = "relaxed";
  private gestureTimer = 0;

  // ⚡ Pre-allocated math objects
  private _qTmp = new THREE.Quaternion();
  private _qTarget = new THREE.Quaternion();

  constructor(vrm: VRM, live: LiveContextController) {
    this.vrm = vrm;
    this.live = live;
    this.cacheBones();
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION
  // --------------------------------------------------------------------------
  private cacheBones() {
    const h = this.vrm.humanoid;
    if (!h) return;

    FINGERS.forEach((finger) => {
      const lBones: THREE.Object3D[] = [];
      const rBones: THREE.Object3D[] = [];
      const lRests: THREE.Quaternion[] = [];
      const rRests: THREE.Quaternion[] = [];

      JOINTS.forEach((joint) => {
        const lName = `left${finger}${joint}`;
        const rName = `right${finger}${joint}`;

        const lBone = h.getNormalizedBoneNode(lName as any);
        const rBone = h.getNormalizedBoneNode(rName as any);

        if (lBone) { lBones.push(lBone); lRests.push(lBone.quaternion.clone()); }
        if (rBone) { rBones.push(rBone); rRests.push(rBone.quaternion.clone()); }
      });

      if (lBones.length > 0) {
        this.leftFingers.set(finger, lBones);
        this.restLeftFingers.set(finger, lRests);
      }
      if (rBones.length > 0) {
        this.rightFingers.set(finger, rBones);
        this.restRightFingers.set(finger, rRests);
      }
    });
  }

  // --------------------------------------------------------------------------
  // MAIN UPDATE LOOP
  // --------------------------------------------------------------------------
  public update(dt: number) {
    if (!this.vrm.humanoid) return;

    const safeDt = Math.min(dt, 0.1);
    this.time += safeDt;

    const speakingState = this.live.getSpeakingState();
    const isSpeaking = speakingState?.isAvatarSpeaking ?? false;
    const isUserSpeaking = speakingState?.isUserSpeaking ?? false;
    const engagement = this.live.getEngagement?.() ?? 0.5;

    // Get exact gestures from Vision System
    const gestures = this.live.getHandGestures();
    
    // Default fallback to relaxed
    let targetLeft = "relaxed";
    let targetRight = "relaxed";

    // 1. If backend sees a gesture, mirror it!
    if (gestures[0]) targetLeft = gestures[0];
    if (gestures[1]) targetRight = gestures[1];
    if (gestures[0] && !gestures[1]) targetRight = gestures[0]; // Mirror single hand to both if seen

    // 2. If no gesture seen, procedurally generate conversational gestures
    if (!gestures[0] && !gestures[1]) {
        this.gestureTimer -= safeDt;
        
        if (isSpeaking && engagement > 0.6 && this.gestureTimer <= 0) {
            const speakingGestures = ["open_palm", "pointing", "peace", "relaxed"];
            targetLeft = speakingGestures[Math.floor(Math.random() * speakingGestures.length)];
            targetRight = targetLeft === "pointing" ? "relaxed" : targetLeft; // Don't double point
            this.gestureTimer = 1.5 + Math.random() * 2.0;
        } 
        else if (isUserSpeaking && this.gestureTimer <= 0 && Math.random() < 0.2) {
            targetLeft = "relaxed";
            targetRight = "relaxed";
            this.gestureTimer = 3.0;
        } 
        else if (this.gestureTimer > 0) {
            // Hold current procedural gesture
            targetLeft = this.currentGestureLeft;
            targetRight = this.currentGestureRight;
        }
    }

    this.setGesture("left", targetLeft, safeDt);
    this.setGesture("right", targetRight, safeDt);

    // Apply micro idle movements
    this.addIdleHandMovement("left", safeDt);
    this.addIdleHandMovement("right", safeDt);

    // Apply to bones
    this.applyFingers(this.leftFingers, this.restLeftFingers, this.currentCurlsLeft, 1);
    this.applyFingers(this.rightFingers, this.restRightFingers, this.currentCurlsRight, -1);
  }

  // --------------------------------------------------------------------------
  // GESTURE & IDLE LOGIC
  // --------------------------------------------------------------------------
  private setGesture(side: "left" | "right", gesture: string, dt: number) {
    const targetCurls = GESTURE_CURLS[gesture] || GESTURE_CURLS["relaxed"];
    const currentKey = side === "left" ? "currentCurlsLeft" : "currentCurlsRight";
    
    FINGERS.forEach((finger) => {
      (this as any)[currentKey][finger] = THREE.MathUtils.damp(
        (this as any)[currentKey][finger], targetCurls[finger], 8.0, dt
      );
    });

    if (side === "left") this.currentGestureLeft = gesture;
    else this.currentGestureRight = gesture;
  }

  private addIdleHandMovement(side: "left" | "right", dt: number) {
    const timeOffset = side === "left" ? 0 : Math.PI;
    const currentKey = side === "left" ? "currentCurlsLeft" : "currentCurlsRight";
    
    FINGERS.forEach((finger) => {
      const idleCurl = Math.sin(this.time * 2 + finger.length + timeOffset) * 0.03;
      (this as any)[currentKey][finger] = THREE.MathUtils.clamp(
        (this as any)[currentKey][finger] + idleCurl * dt, 0, 1
      );
    });
  }

  // --------------------------------------------------------------------------
  // FINGER APPLICATION
  // --------------------------------------------------------------------------
  private applyFingers(
    fingerMap: Map<string, THREE.Object3D[]>,
    restMap: Map<string, THREE.Quaternion[]>,
    curls: Record<string, number>,
    mirrorScale: number
  ) {
    fingerMap.forEach((bones, fingerName) => {
      const restPoses = restMap.get(fingerName);
      if (!restPoses) return;

      const curlAmount = curls[fingerName];

      bones.forEach((bone, index) => {
        const maxBend = index === 0 ? 1.2 : 1.5;
        let angle = curlAmount * maxBend;

        // Thumb rotates diagonally inward
        if (fingerName === "Thumb") {
          const axis = new THREE.Vector3(0, 0.5 * mirrorScale, 0.5 * mirrorScale).normalize();
          this._qTmp.setFromAxisAngle(axis, angle);
        } else {
          // Standard fingers curl on Z axis
          this._qTmp.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle * mirrorScale);
        }

        // Multiply rotation against Rest Pose to prevent breaking fingers
        this._qTarget.copy(restPoses[index]).multiply(this._qTmp);
        bone.quaternion.copy(this._qTarget);
      });
    });
  }
}
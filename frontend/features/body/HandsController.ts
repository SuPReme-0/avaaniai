// features/body/HandsController.ts
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { LiveContextController } from "../live/LiveContextController";

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Little"];
const JOINTS = ["Proximal", "Intermediate", "Distal"];

// ⚡ TWEAK THIS: 1 or -1 to flip finger curling direction if they bend backward
const FINGER_BEND_DIRECTION = -1; 

// 1. Finger Curls (0.0 = flat, 1.0 = fully curled)
const GESTURE_CURLS: Record<string, Record<string, number>> = {
  relaxed: { Thumb: 0.15, Index: 0.2, Middle: 0.25, Ring: 0.3, Little: 0.35 },
  open_palm: { Thumb: 0.0, Index: 0.0, Middle: 0.0, Ring: 0.0, Little: 0.0 },
  fist: { Thumb: 0.9, Index: 1.0, Middle: 1.0, Ring: 1.0, Little: 1.0 },
  pointing: { Thumb: 0.7, Index: 0.0, Middle: 0.8, Ring: 0.8, Little: 0.8 },
  peace: { Thumb: 0.7, Index: 0.0, Middle: 0.0, Ring: 0.8, Little: 0.8 },
  thumbs_up: { Thumb: 0.0, Index: 0.9, Middle: 0.9, Ring: 0.9, Little: 0.9 },
  sad_limp: { Thumb: 0.3, Index: 0.4, Middle: 0.5, Ring: 0.6, Little: 0.7 },
  thoughtful: { Thumb: 0.2, Index: 0.1, Middle: 0.8, Ring: 0.9, Little: 0.9 }, // Index extended, others curled
};

export type ArmPose = { lUp: number[]; lLow: number[]; rUp: number[]; rLow: number[]; handGest: string; };

// 2. Strict Pose Dictionary (X=Pitch, Y=Yaw, Z=Roll)
// ⚡ Left Arm UP = -Z. Right Arm UP = -Z.
// ⚡ Elbow BEND FORWARD = -X.
const ARM_POSES: Record<string, ArmPose> = {
  REST: {
    lUp: [0.05, 0.05, -1.3], lLow: [-0.1, 0, 0],
    rUp: [0.05, -0.05, 1.3], rLow: [-0.1, 0, 0],
    handGest: "relaxed"
  },
  SAD_REST: {
    lUp: [0.15, 0.1, -1.2], lLow: [-0.05, 0, 0],
    rUp: [0.15, -0.1, 1.2], rLow: [-0.05, 0, 0],
    handGest: "sad_limp"
  },
  THINKING_CHIN: {
    // ⚡ REALISM: Left arm crosses body to support the right elbow, right hand on chin
    lUp: [-0.2, 0.4, -1.1],  lLow: [-1.4, 0, 0],
    rUp: [-0.3, -0.4, -1.3], rLow: [-2.2, 0, 0],
    handGest: "thoughtful" 
  },
  THINKING_HEAD_TOUCH: {
    // Right arm high, elbow bent sharply to touch the temple/head
    lUp: [0.05, 0.05, -1.3], lLow: [-0.1, 0, 0],
    rUp: [-0.5, -0.2, -1.5], rLow: [-2.1, 0, 0],
    handGest: "thoughtful"
  },
  HAIR_TUCK: {
    lUp: [-0.1, 0.5, -0.6],  lLow: [-2.1, 0, 0],
    rUp: [0.05, -0.05, 1.3], rLow: [-0.1, 0, 0],
    handGest: "open_palm"
  },
  EXPLAIN_OPEN: {
    // Highly animated, both arms wide
    lUp: [0.2, 0.2, -0.6], lLow: [-1.2, 0, 0],
    rUp: [0.2, -0.2, 0.6], rLow: [-1.2, 0, 0],
    handGest: "open_palm"
  },
  EXPLAIN_ONE_HAND: {
    // Casual talking, one hand articulating
    lUp: [0.05, 0.05, -1.3], lLow: [-0.1, 0, 0],
    rUp: [0.2, -0.4, 0.4],   rLow: [-1.5, 0, 0],
    handGest: "relaxed"
  },
  LISTEN_CLASPED: {
    // Hands resting together loosely at the waist
    lUp: [0.1, 0.3, -1.1], lLow: [-0.8, 0, 0],
    rUp: [0.1, -0.3, 1.1], rLow: [-0.8, 0, 0],
    handGest: "relaxed"
  },
  WAVE_HIGH: {
    lUp: [0.05, 0.05, -1.3], lLow: [-0.1, 0, 0],
    rUp: [-0.1, -0.1, -0.8], rLow: [-0.3, 0, -0.3], 
    handGest: "open_palm"
  },
  SURPRISED_HANDS: {
    lUp: [0.1, 0.4, -0.8],  lLow: [-1.8, 0, 0],
    rUp: [0.1, -0.4, 0.8],  rLow: [-1.8, 0, 0],
    handGest: "open_palm"
  },
  PEACE_SIGN: {
    lUp: [0.05, 0.05, -1.3], lLow: [-0.1, 0, 0],
    rUp: [0, -0.3, 0.2],     rLow: [-1.8, 0, 0],
    handGest: "peace"
  },
  GROOVING_1: {
    lUp: [0.2, 0.2, -0.9], lLow: [-0.8, 0, 0],
    rUp: [0.2, -0.2, 0.9], rLow: [-0.8, 0, 0],
    handGest: "fist"
  },
  GROOVING_2: {
    lUp: [0.1, 0.1, -1.1], lLow: [-0.4, 0, 0],
    rUp: [0.1, -0.1, 1.1], rLow: [-0.4, 0, 0],
    handGest: "peace"
  }
};

// ============================================================================
// HANDS & ARMS CONTROLLER
// ============================================================================
export class HandsController {
  private vrm: VRM;
  private live: LiveContextController;

  // Caches
  private leftFingers = new Map<string, THREE.Object3D[]>();
  private rightFingers = new Map<string, THREE.Object3D[]>();
  private restLeftFingers = new Map<string, THREE.Quaternion[]>();
  private restRightFingers = new Map<string, THREE.Quaternion[]>();
  
  private armBones: Record<string, THREE.Object3D | null> = {};
  private restArmQuats = new Map<string, THREE.Quaternion>();

  // Smoothing State
  private currentCurlsLeft: Record<string, number> = { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 };
  private currentCurlsRight: Record<string, number> = { Thumb: 0, Index: 0, Middle: 0, Ring: 0, Little: 0 };
  
  private armSmoothState = {
    lUp: [...ARM_POSES.REST.lUp], lLow: [...ARM_POSES.REST.lLow],
    rUp: [...ARM_POSES.REST.rUp], rLow: [...ARM_POSES.REST.rLow]
  };

  private time = 0;
  
  // ⚡ Conversational State Machine
  private activePoseName = "REST";
  private currentPose: ArmPose = ARM_POSES.REST;
  private poseTimer = 0;
  private interruptCooldown = 0;
  
  private silenceTimer = 0;
  private currentPhase = "IDLE"; 

  private _euler = new THREE.Euler(0, 0, 0, "XYZ");
  private _qTmp = new THREE.Quaternion();
  private _qTarget = new THREE.Quaternion();

  constructor(vrm: VRM, live: LiveContextController) {
    this.vrm = vrm;
    this.live = live;
    this.cacheBones();
  }

  private cacheBones() {
    const h = this.vrm.humanoid;
    if (!h) return;

    FINGERS.forEach((finger) => {
      const lBones: THREE.Object3D[] = [];
      const rBones: THREE.Object3D[] = [];
      const lRests: THREE.Quaternion[] = [];
      const rRests: THREE.Quaternion[] = [];

      JOINTS.forEach((joint) => {
        const lBone = h.getNormalizedBoneNode(`left${finger}${joint}` as any);
        const rBone = h.getNormalizedBoneNode(`right${finger}${joint}` as any);
        if (lBone) { lBones.push(lBone); lRests.push(lBone.quaternion.clone()); }
        if (rBone) { rBones.push(rBone); rRests.push(rBone.quaternion.clone()); }
      });

      if (lBones.length > 0) { this.leftFingers.set(finger, lBones); this.restLeftFingers.set(finger, lRests); }
      if (rBones.length > 0) { this.rightFingers.set(finger, rBones); this.restRightFingers.set(finger, rRests); }
    });

    const armNames = ["leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", "leftHand", "rightHand"] as const;
    armNames.forEach(name => {
      const bone = h.getNormalizedBoneNode(name as any);
      if (bone) {
        this.armBones[name] = bone;
        this.restArmQuats.set(name, bone.quaternion.clone());
      }
    });
  }

  private setPose(poseName: string, duration: number) {
    if (this.activePoseName === poseName) {
        this.poseTimer = Math.max(this.poseTimer, duration);
        return;
    }
    this.activePoseName = poseName;
    this.currentPose = ARM_POSES[poseName] || ARM_POSES.REST;
    this.poseTimer = duration;
  }

  public update(dt: number) {
    if (!this.vrm.humanoid) return;

    const safeDt = Math.min(dt, 0.1);
    this.time += safeDt;
    this.poseTimer -= safeDt;
    this.interruptCooldown -= safeDt;

    const speakingState = this.live.getSpeakingState();
    const isAvatarSpeaking = speakingState?.isAvatarSpeaking ?? false;
    const isUserSpeaking = speakingState?.isUserSpeaking ?? false;
    const emotions = this.live.getEmotions();
    const energy = this.live.getEnergy();
    const userGestures = this.live.getHandGestures();
    
    // ⚡ Calculate Silence/Thinking Phase
    if (!isUserSpeaking && !isAvatarSpeaking) {
        this.silenceTimer += safeDt;
    } else {
        this.silenceTimer = 0;
    }

    // Determine current conversation phase
    let newPhase = "IDLE";
    if (isUserSpeaking) newPhase = "LISTENING";
    else if (isAvatarSpeaking) newPhase = "SPEAKING";
    else if (this.silenceTimer < 4.0) newPhase = "THINKING"; // LLM is generating

    // ⚡ FORCE INTERRUPT: If phase changes, instantly drop current pose timer
    if (newPhase !== this.currentPhase) {
        this.poseTimer = 0;
        this.currentPhase = newPhase;
    }

    this.evaluateBehavior(newPhase, emotions, energy, userGestures);
    this.applyArms(safeDt, energy);
    
    let targetLeft = userGestures[0] || this.currentPose.handGest;
    let targetRight = userGestures[1] || this.currentPose.handGest;
    if (userGestures[0] && !userGestures[1]) targetRight = userGestures[0]; 

    this.applyFingersLogic(safeDt, targetLeft, targetRight);
  }

  private evaluateBehavior(phase: string, emotions: any, energy: number, userGestures: string[]) {
    // --- HIGH PRIORITY INTERRUPTS (Visual Gestures) ---
    if (this.interruptCooldown <= 0) {
        if (userGestures.includes("open_palm") && energy > 0.4) {
            this.setPose("WAVE_HIGH", 3.0);
            this.interruptCooldown = 5.0;
            return;
        }
        if (userGestures.includes("peace")) {
            this.setPose("PEACE_SIGN", 3.0);
            this.interruptCooldown = 5.0;
            return;
        }
        if ((emotions.surprised || 0) > 0.7) {
            this.setPose("SURPRISED_HANDS", 2.0);
            this.interruptCooldown = 3.0;
            return;
        }
    }

    // Do not change pose if still executing current animation
    if (this.poseTimer > 0) return;

    const happy = emotions.happy || 0;
    const sad = emotions.sad || 0;

    // --- PHASE BEHAVIORS ---
    if (phase === "THINKING") {
        // Deep thought! Touch head or chin organically
        const thinkPose = Math.random() > 0.5 ? "THINKING_HEAD_TOUCH" : "THINKING_CHIN";
        this.setPose(thinkPose, 3.0 + Math.random() * 2.0);
        return;
    }

    if (phase === "SPEAKING") {
        if (happy > 0.6) {
            const next = Math.random() > 0.4 ? "EXPLAIN_OPEN" : "EXPLAIN_ONE_HAND";
            this.setPose(next, 2.0 + Math.random() * 2.0);
        } else if (sad > 0.5) {
            this.setPose("LISTEN_CLASPED", 3.0);
        } else {
            const options = ["EXPLAIN_ONE_HAND", "LISTEN_CLASPED", "REST"];
            this.setPose(options[Math.floor(Math.random() * options.length)], 2.5 + Math.random() * 2.0);
        }
        return;
    }

    if (phase === "LISTENING") {
        if (happy > 0.5) {
            this.setPose("REST", 3.0); 
        } else {
            const next = Math.random() > 0.4 ? "LISTEN_CLASPED" : "THINKING_CHIN";
            this.setPose(next, 3.0 + Math.random() * 3.0);
        }
        return;
    }

    // IDLE
    if (energy > 0.85) {
        const nextGroove = this.activePoseName === "GROOVING_1" ? "GROOVING_2" : "GROOVING_1";
        this.setPose(nextGroove, 1.2);
    } else if (sad > 0.5) {
        this.setPose("SAD_REST", 5.0);
    } else {
        const r = Math.random();
        if (r < 0.2) this.setPose("HAIR_TUCK", 3.0);
        else if (r < 0.4) this.setPose("LISTEN_CLASPED", 4.0);
        else this.setPose("REST", 5.0);
    }
  }

  private applyArms(dt: number, energy: number) {
    const lerpSpeed = 4.0 * dt; // Faster, snappier transitions for true realism

    const lerpArray = (current: number[], target: number[], speed: number) => {
      return current.map((val, i) => THREE.MathUtils.lerp(val, target[i], speed));
    };

    this.armSmoothState.lUp = lerpArray(this.armSmoothState.lUp, this.currentPose.lUp, lerpSpeed);
    this.armSmoothState.lLow = lerpArray(this.armSmoothState.lLow, this.currentPose.lLow, lerpSpeed);
    this.armSmoothState.rUp = lerpArray(this.armSmoothState.rUp, this.currentPose.rUp, lerpSpeed);
    this.armSmoothState.rLow = lerpArray(this.armSmoothState.rLow, this.currentPose.rLow, lerpSpeed);

    // Micro-movements to keep arms organically alive
    const armJitterX = Math.sin(this.time * 1.5) * 0.02 * energy;
    const armJitterZ = Math.cos(this.time * 2.0) * 0.02 * energy;

    const applyBone = (name: string, angles: number[], isUpper: boolean, isLeft: boolean) => {
      const bone = this.armBones[name];
      const rest = this.restArmQuats.get(name);
      if (!bone || !rest) return;

      const jX = isUpper ? armJitterX : 0;
      const jZ = isUpper ? (isLeft ? armJitterZ : -armJitterZ) : 0;

      this._euler.set(angles[0] + jX, angles[1], angles[2] + jZ, "XYZ");
      this._qTmp.setFromEuler(this._euler);
      this._qTarget.copy(rest).multiply(this._qTmp);
      
      bone.quaternion.copy(this._qTarget);
    };

    applyBone("leftUpperArm", this.armSmoothState.lUp, true, true);
    applyBone("leftLowerArm", this.armSmoothState.lLow, false, true);
    applyBone("rightUpperArm", this.armSmoothState.rUp, true, false);
    applyBone("rightLowerArm", this.armSmoothState.rLow, false, false);
  }

  private applyFingersLogic(dt: number, targetLeft: string, targetRight: string) {
    const leftCurls = GESTURE_CURLS[targetLeft] || GESTURE_CURLS["relaxed"];
    const rightCurls = GESTURE_CURLS[targetRight] || GESTURE_CURLS["relaxed"];
    
    FINGERS.forEach((finger) => {
      this.currentCurlsLeft[finger] = THREE.MathUtils.damp(this.currentCurlsLeft[finger], leftCurls[finger], 8.0, dt);
      this.currentCurlsRight[finger] = THREE.MathUtils.damp(this.currentCurlsRight[finger], rightCurls[finger], 8.0, dt);
      
      const idleCurl = Math.sin(this.time * 2 + finger.length) * 0.02;
      this.currentCurlsLeft[finger] = THREE.MathUtils.clamp(this.currentCurlsLeft[finger] + idleCurl, 0, 1);
      this.currentCurlsRight[finger] = THREE.MathUtils.clamp(this.currentCurlsRight[finger] + idleCurl, 0, 1);
    });

    this.applyFingers(this.leftFingers, this.restLeftFingers, this.currentCurlsLeft, 1);
    this.applyFingers(this.rightFingers, this.restRightFingers, this.currentCurlsRight, -1);
  }

  private applyFingers(fingerMap: Map<string, THREE.Object3D[]>, restMap: Map<string, THREE.Quaternion[]>, curls: Record<string, number>, mirrorScale: number) {
    fingerMap.forEach((bones, fingerName) => {
      const restPoses = restMap.get(fingerName);
      if (!restPoses) return;

      const curlAmount = curls[fingerName];

      bones.forEach((bone, index) => {
        const maxBend = index === 0 ? 1.2 : 1.5;
        let angle = curlAmount * maxBend * FINGER_BEND_DIRECTION;

        if (fingerName === "Thumb") {
          const axis = new THREE.Vector3(0, 0.5 * mirrorScale, 0.5 * mirrorScale).normalize();
          this._qTmp.setFromAxisAngle(axis, angle);
        } else {
          this._qTmp.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle * mirrorScale);
        }

        this._qTarget.copy(restPoses[index]).multiply(this._qTmp);
        bone.quaternion.copy(this._qTarget);
      });
    });
  }
}
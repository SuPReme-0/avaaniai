// features/live/LiveContextController.ts
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { streamManager } from "@/lib/vrm/streamManager";

// ============================================================================
// TYPES
// ============================================================================
export type AvaaniLiveContext = {
  identity?: string;
  identity_confidence?: number;
  person_count?: number;
  emotion?: string;
  emotion_intensity?: number;
  emotion_probs?: Record<string, number>;
  state_confidence?: number;
  energy_level?: number;
  attention?: number;
  engagement?: number;
  gaze?: { score?: number; vector?: string };
  tracking?: { x?: number; y?: number; z?: number; visible?: boolean };
  posture?: { inclination?: number; facing_camera?: boolean; energy?: number };
  gestures?: string[];
  holding?: string[];
  surroundings?: string[];
  timestamp?: number;
  system_status?: string;
  is_speaking?: boolean;
  avatar_speaking?: boolean;
  audio_volume?: number; 
  hands?: {
    left?: { landmarks?: Array<{ x: number; y: number; z: number }>; bbox?: number[]; handedness?: string; gesture?: string; };
    right?: { landmarks?: Array<{ x: number; y: number; z: number }>; bbox?: number[]; handedness?: string; gesture?: string; };
  };
};

// ⚡ FAST MATH OPTIMIZATION
const smooth = (current: number, target: number, smoothTime: number, dt: number): number => {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  return current + (target - current) * (1 - exp);
};

const HUMAN_CONSTRAINTS = {
  NECK_PITCH: { min: -0.35, max: 0.45 },
  NECK_YAW: { min: -0.6, max: 0.6 },
  SPINE_BEND: { min: -0.2, max: 0.3 },
  SHOULDER_RAISE: { min: 0, max: 0.4 },
};

const EMOTION_PHYSIOLOGY: Record<string, { spine: number; shoulders: number; headTilt: number; energy: number }> = {
  happy: { spine: 0.15, shoulders: -0.1, headTilt: 0.05, energy: 1.2 },
  sad: { spine: -0.25, shoulders: 0.2, headTilt: -0.1, energy: 0.6 },
  surprised: { spine: 0.2, shoulders: 0.3, headTilt: 0.15, energy: 2.0 },
  angry: { spine: -0.1, shoulders: 0.15, headTilt: -0.05, energy: 1.5 },
};

// ============================================================================
// MAIN CONTROLLER
// ============================================================================
export class LiveContextController {
  private vrm: VRM;
  private ctx: AvaaniLiveContext = {};

  private state = {
    emotions: { happy: 0, sad: 0, angry: 0, surprised: 0, neutral: 1 },
    spineBend: 0, shoulderHeight: 0, headPitch: 0, headYaw: 0,
    gazeX: 0, gazeY: 0, gazeVisible: false,
    saccadeTimer: 0, saccadeIntensity: 0,
    idleWeight: 0.3, breathPhase: 0, breathDepth: 0.02, gestureWeight: 0,
    isUserSpeaking: false, isAvatarSpeaking: false,
    confidence: 0.8, energy: 0.6,
    audioVolume: 0, 
    leftHandLandmarks: null as Array<{ x: number; y: number; z: number }> | null,
    rightHandLandmarks: null as Array<{ x: number; y: number; z: number }> | null,
  };

  private targets = { spineBend: 0, shoulderHeight: 0, headPitch: 0, headYaw: 0, idleWeight: 0.3, breathDepth: 0.02 };

  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx2D: CanvasRenderingContext2D | null = null;
  private isVideoActive = false;
  private lastVideoFrame = 0;
  private readonly VIDEO_THROTTLE_MS = 66; // ~15fps
  
  // ⚡ REUSABLE FILE READER FOR ASYNC ENCODING
  private fileReader = new FileReader();
  private isEncoding = false;

  constructor(vrm: VRM) {
    this.vrm = vrm;
    
    // Setup the async reader callback
    this.fileReader.onloadend = () => {
      const base64Url = this.fileReader.result as string;
      const base64Data = base64Url.substring(23); // Strip "data:image/jpeg;base64,"
      
      if (base64Data) {
        streamManager.sendJSON({ type: "video", payload: base64Data });
      }
      this.isEncoding = false; // Free the lock
    };
  }

  public setContext(data: AvaaniLiveContext) {
    if (data.is_speaking !== undefined) this.state.isUserSpeaking = data.is_speaking;
    if (data.avatar_speaking !== undefined) this.state.isAvatarSpeaking = data.avatar_speaking;
    if (data.audio_volume !== undefined) this.state.audioVolume = data.audio_volume; 
    
    // ⚡ OPTIMIZATION: In-place mutation prevents heavy Garbage Collection
    Object.assign(this.ctx, data);
  }

  public setAvatarSpeaking(speaking: boolean) { 
    this.state.isAvatarSpeaking = speaking;
    this.ctx.avatar_speaking = speaking;
  }
  
  public getEngagement() { 
    return this.ctx.engagement ?? 0.5; 
  }
  
  public setUserSpeaking(speaking: boolean) { 
    this.state.isUserSpeaking = speaking;
    this.ctx.is_speaking = speaking;
  }

  public update(dt: number) {
    const delta = Math.min(0.1, dt);

    const probs = this.ctx.emotion_probs || { neutral: 1 };
    const rawConfidence = Math.max(0.3, this.ctx.state_confidence ?? this.ctx.attention ?? 0.8);
    this.state.confidence = smooth(this.state.confidence, rawConfidence, 0.3, delta);

    let totalWeight = 0, targetSpine = 0, targetShoulders = 0, targetHeadTilt = 0, targetEnergy = 0;
    
    this.state.emotions.happy = 0;
    this.state.emotions.sad = 0;
    this.state.emotions.angry = 0;
    this.state.emotions.surprised = 0;
    this.state.emotions.neutral = 0;

    for (const [emotion, weight] of Object.entries(probs)) {
      totalWeight += weight;
      const physio = EMOTION_PHYSIOLOGY[emotion];
      if (physio) {
        targetSpine += physio.spine * weight;
        targetShoulders += physio.shoulders * weight;
        targetHeadTilt += physio.headTilt * weight;
        targetEnergy += physio.energy * weight;
        (this.state.emotions as any)[emotion] = weight;
      } else if (emotion === "neutral") {
        this.state.emotions.neutral = weight;
      }
    }

    if (totalWeight > 0) {
      targetSpine /= totalWeight; targetShoulders /= totalWeight;
      targetHeadTilt /= totalWeight; targetEnergy /= totalWeight;
    }

    const confidenceFactor = THREE.MathUtils.mapLinear(this.state.confidence, 0.3, 0.9, 0.6, 1.2);
    targetSpine *= confidenceFactor; targetShoulders *= confidenceFactor;
    targetHeadTilt *= confidenceFactor; targetEnergy = THREE.MathUtils.clamp(targetEnergy, 0.3, 2.0);

    const track = this.ctx.tracking || {};
    this.state.gazeVisible = !!(track.visible && this.state.confidence > 0.4);

    if (this.state.gazeVisible && track.x !== undefined && track.y !== undefined) {
      const rawX = (track.x - 0.5) * 2;
      const rawY = (0.5 - track.y) * 1.5;

      this.targets.headYaw = THREE.MathUtils.clamp(rawX * 0.8, HUMAN_CONSTRAINTS.NECK_YAW.min, HUMAN_CONSTRAINTS.NECK_YAW.max);
      this.targets.headPitch = THREE.MathUtils.clamp(rawY * 0.6 + targetHeadTilt, HUMAN_CONSTRAINTS.NECK_PITCH.min, HUMAN_CONSTRAINTS.NECK_PITCH.max);

      const gazeSpeed = 8.0 + targetEnergy * 2;
      this.state.headYaw = smooth(this.state.headYaw, this.targets.headYaw, 0.12 / gazeSpeed, delta);
      this.state.headPitch = smooth(this.state.headPitch, this.targets.headPitch, 0.12 / gazeSpeed, delta);

      this.state.saccadeTimer += delta;
      if (this.state.saccadeTimer > 0.8 + Math.random() * 1.2) {
        this.state.saccadeIntensity = Math.random() * 0.03 * (2 - this.state.confidence);
        this.state.saccadeTimer = 0;
      }

      this.state.gazeX = rawX + Math.sin(this.state.saccadeTimer * 15) * this.state.saccadeIntensity;
      this.state.gazeY = rawY + Math.cos(this.state.saccadeTimer * 10) * this.state.saccadeIntensity * 0.7;
    } else {
      this.state.headYaw = smooth(this.state.headYaw, 0, 0.2, delta);
      this.state.headPitch = smooth(this.state.headPitch, 0, 0.2, delta);
      this.state.gazeX = smooth(this.state.gazeX, 0, 0.3, delta);
      this.state.gazeY = smooth(this.state.gazeY, 0, 0.3, delta);
    }

    const postureInclination = this.ctx.posture?.inclination || 0;
    this.targets.spineBend = THREE.MathUtils.clamp(targetSpine + postureInclination * -0.3, HUMAN_CONSTRAINTS.SPINE_BEND.min, HUMAN_CONSTRAINTS.SPINE_BEND.max);
    this.targets.shoulderHeight = THREE.MathUtils.clamp(targetShoulders, HUMAN_CONSTRAINTS.SHOULDER_RAISE.min, HUMAN_CONSTRAINTS.SHOULDER_RAISE.max);

    this.state.spineBend = smooth(this.state.spineBend, this.targets.spineBend, 0.4, delta);
    this.state.shoulderHeight = smooth(this.state.shoulderHeight, this.targets.shoulderHeight, 0.5, delta);

    const breathSpeed = 0.8 + targetEnergy * 0.4;
    this.state.breathPhase = (this.state.breathPhase + delta * breathSpeed) % 1;
    this.targets.breathDepth = 0.015 + 0.015 * this.state.energy * targetEnergy;
    this.state.breathDepth = smooth(this.state.breathDepth, this.targets.breathDepth, 0.3, delta);

    const baseIdle = this.state.isUserSpeaking ? 0.15 : this.state.isAvatarSpeaking ? 0.4 : 0.25;
    this.targets.idleWeight = baseIdle * Math.min(1.5, targetEnergy);
    this.state.idleWeight = smooth(this.state.idleWeight, this.targets.idleWeight, 0.3, delta);

    const hasActiveGesture = (this.ctx.gestures || []).length > 0;
    const proceduralGestureWeight = this.state.isAvatarSpeaking ? Math.min(0.7, this.ctx.engagement || 0.5) * this.state.energy : (this.state.isUserSpeaking ? 0.2 * this.state.energy : 0);
    this.state.gestureWeight = smooth(this.state.gestureWeight, Math.max(proceduralGestureWeight, hasActiveGesture ? 0.8 : 0), hasActiveGesture ? 0.15 : 0.4, delta);
    
    this.state.energy = smooth(this.state.energy, this.ctx.energy_level ?? 0.6, 0.3, delta);
    this.state.leftHandLandmarks = this.ctx.hands?.left?.landmarks || null;
    this.state.rightHandLandmarks = this.ctx.hands?.right?.landmarks || null;
  }

  // ==========================================================================
  // GETTERS 
  // ==========================================================================
  public getEmotions() { return { ...this.state.emotions }; }
  public getPosture() { return { spineBend: this.state.spineBend, shoulderHeight: this.state.shoulderHeight, headPitch: this.state.headPitch, headYaw: this.state.headYaw, breathPhase: this.state.breathPhase, breathDepth: this.state.breathDepth, idleWeight: this.state.idleWeight, gestureWeight: this.state.gestureWeight }; }
  public getGaze() { return { x: this.state.gazeX, y: this.state.gazeY, visible: this.state.gazeVisible, headPitch: this.state.headPitch, headYaw: this.state.headYaw }; }
  public getSpeakingState() { return { isUserSpeaking: this.state.isUserSpeaking, isAvatarSpeaking: this.state.isAvatarSpeaking, confidence: this.state.confidence }; }
  public getAudioVolume() { return this.state.audioVolume; }
  public getEnergy() { return this.state.energy; }
  public getLeftHandLandmarks() { return this.state.leftHandLandmarks; }
  public getRightHandLandmarks() { return this.state.rightHandLandmarks; }
  public getHandGestures(): string[] { return [this.ctx.hands?.left?.gesture, this.ctx.hands?.right?.gesture].filter(Boolean) as string[]; }
  
  public getTracking() { return this.ctx.tracking || { visible: false, x: 0.5, y: 0.5, z: 0.5 }; }
  public getAttention() { return this.ctx.attention ?? 0.5; }
  public getConfidence() { return this.state.confidence; }
  public getGestures() { return this.ctx.gestures || []; }
  public getLean() { return this.ctx.posture?.inclination ?? 0; }
  public getGazeScore() { return this.ctx.gaze?.score ?? 0; }

  // ==========================================================================
  // VIDEO CAPTURE 
  // ==========================================================================
  public async startVideo() {
    if (this.isVideoActive || typeof document === "undefined") return;
    try {
      this.video = document.createElement("video");
      this.canvas = document.createElement("canvas");
      this.canvas.width = 320; this.canvas.height = 240;
      this.ctx2D = this.canvas.getContext("2d", { willReadFrequently: true, alpha: false });
      if (!this.ctx2D) throw new Error("Canvas 2D unavailable");

      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: "user" } 
      });
      this.video.srcObject = stream;
      this.video.playsInline = true;
      this.video.muted = true;
      await this.video.play();

      this.isVideoActive = true;
      requestAnimationFrame(this.processVideoFrame);
    } catch (e) { 
        console.error("👁️ Camera access error:", e); 
    }
  }

  public stopVideo() {
    if (!this.isVideoActive) return;
    this.isVideoActive = false;
    if (this.video?.srcObject) {
      (this.video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
    }
  }

  private processVideoFrame = () => {
    if (!this.isVideoActive || !this.video || !this.ctx2D || !this.canvas) return;
    
    const now = performance.now();
    
    if (now - this.lastVideoFrame > this.VIDEO_THROTTLE_MS && this.video.readyState === 4) {
      // ⚡ PREVENT QUEUE BUILDUP: Skip encoding if the previous frame is still processing
      if (!this.isEncoding) {
          this.lastVideoFrame = now;
          this.ctx2D.drawImage(this.video, 0, 0, 320, 240);
          
          this.isEncoding = true;
          // ⚡ ASYNC NON-BLOCKING ENCODING
          // ⚡ ASYNC NON-BLOCKING ENCODING (Bulletproofed)
          this.canvas.toBlob((blob) => {
              if (blob) {
                  try {
                      this.fileReader.readAsDataURL(blob);
                  } catch (e) {
                      console.warn("Frame read error:", e);
                      this.isEncoding = false;
                  }
              } else {
                  this.isEncoding = false;
              }
          }, "image/jpeg", 0.5);
      }
    }
    
    requestAnimationFrame(this.processVideoFrame);
  };
}
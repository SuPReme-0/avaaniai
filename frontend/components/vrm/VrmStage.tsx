"use client";

import React, { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

import { loadVrm } from "@/lib/vrm/loadVrm";
import { createRenderer } from "@/lib/three/createRenderer";
import { createScene } from "@/lib/three/createScene";
import { disposeObject3D } from "@/lib/vrm/disposeThree";

import { BodyController } from "@/features/body/BodyController";
import { PhysicsController } from "@/features/physics/PhysicsController";
import { PoseController } from "@/features/body/PoseController";
import { IdleBodyController } from "@/features/body/IdleBodyController";
import { IdleFaceController } from "@/features/body/FaceController";
import { IdleHandController } from "@/features/body/IdleHandController";
import { LiveContextController } from "@/features/live/LiveContextController";
import { EmotionName } from "@/features/emotions/emotionPresets";

interface VrmStageProps {
  emotion?: EmotionName;
}

const VrmStage = forwardRef((props: VrmStageProps, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rafRef = useRef<number | null>(null);
  
  // High-performance animation refs
  const mouthOpenTarget = useRef(0);
  const currentEmotion = useRef<EmotionName>("neutral");
  
  // Reference to internal controllers for direct manipulation
  const controllersRef = useRef<any>({});

  // ---------------------------------------------------------
  // 1. IMPERATIVE API (Connected to StreamManager & Dashboard)
  // ---------------------------------------------------------
  useImperativeHandle(ref, () => ({
    triggerMouthPop: () => {
      mouthOpenTarget.current = 0.85; 
      setTimeout(() => {
        if (mouthOpenTarget.current > 0) mouthOpenTarget.current = 0.25; 
      }, 80);
    },
    stopMouth: () => {
      mouthOpenTarget.current = 0;
    },
    // The "Soul" Update: Syncs face, body, and pose
    setExpression: (name: EmotionName) => {
      const emo = name.toLowerCase() as EmotionName;
      currentEmotion.current = emo;
      
      // Update individual controller states immediately
      const c = controllersRef.current;
      c.face?.setEmotion(emo);
      c.body?.setEmotion(emo);
      c.pose?.setEmotion(emo);
    }
  }));

  useEffect(() => {
    let mounted = true;
    const canvas = canvasRef.current;
    if (!canvas || rendererRef.current) return;

    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    const scene = createScene();
    const clock = new THREE.Clock();

    const camera = new THREE.PerspectiveCamera(25, 1, 0.1, 20);
    camera.position.set(0, 1.4, 2.1); 
    camera.lookAt(new THREE.Vector3(0, 1.15, 0));

    const avatarRoot = new THREE.Group();
    scene.add(avatarRoot);

    let vrm: VRM | null = null;

    // Responsive Logic
    const onResize = () => {
      if (!canvas.parentElement) return;
      const w = canvas.parentElement.clientWidth;
      const h = canvas.parentElement.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    };
    window.addEventListener("resize", onResize);

    (async () => {
      try {
        const loaded = (await loadVrm("/models/character.vrm")) as VRM | null;
        if (!mounted || !loaded) return;
        vrm = loaded;
        avatarRoot.add(vrm.scene);

        // Initialize Specialized Controllers with shared ref
        const c = controllersRef.current;
        c.pose = new PoseController(vrm);
        c.body = new BodyController(vrm);
        c.physics = new PhysicsController(vrm);
        c.live = new LiveContextController(vrm);
        c.face = new IdleFaceController(vrm);
        c.hand = new IdleHandController(vrm);
        c.idle = new IdleBodyController(vrm, {
          intensity: 0.9, breathe: 1.0, sway: 1.0, head: 0.9, slerp: 0.22,
        });

        vrm.update(0);
        onResize();
      } catch (e) { 
        console.error("VRM Load Error:", e); 
      }
    })();

    const animate = () => {
      if (!mounted) return;
      rafRef.current = requestAnimationFrame(animate);
      
      const dt = clock.getDelta();
      const t = clock.getElapsedTime();

      if (vrm) {
        const c = controllersRef.current;

        // 1. BASELINE UPDATES (Body scale, wind, hand sway)
        c.body?.update(dt);
        c.physics?.applyWind?.(t);
        c.hand?.update(dt);
        c.live?.update(dt);

        // 2. POSE & IDLE (Shoulder slump, breathing)
        // PoseController now uses the currentEmotion internally
        c.pose?.update(dt);
        
        // Idle intensity reacts to emotion energy via the dashboard's logic if needed,
        // or we can manually scale it here.
        c.idle?.update?.(dt);

        // 3. EYE & BLINK LOGIC
        const gazeScore = c.live?.getGazeScore?.() ?? 0;
        const visible = c.live?.getTrackingVisible?.() ?? false;
        c.face?.setLiveGaze({ strength: gazeScore, visible });
        c.face?.update(dt);

        // 4. MANUAL OVERRIDES (Mouth & Blendshapes)
        if (vrm.expressionManager) {
          // A. LIP SYNC
          const currentA = vrm.expressionManager.getValue("aa") ?? 0;
          const nextMouthValue = THREE.MathUtils.lerp(currentA, mouthOpenTarget.current, 0.4);
          
          vrm.expressionManager.setValue("aa", nextMouthValue);
          vrm.expressionManager.setValue("ih", nextMouthValue * 0.1); 
          
          // B. REFRESH EXPRESSION MANAGER
          // The FaceController already updates the facial muscles during its .update(dt) call,
          // so we only need one final update call.
          vrm.expressionManager.update();
        }

        vrm.update(dt);
      }
      renderer.render(scene, camera);
    };

    animate();

    return () => {
      mounted = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      if (vrm?.scene) {
        avatarRoot.remove(vrm.scene);
        disposeObject3D(vrm.scene);
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div className="w-full h-full relative overflow-hidden bg-transparent">
      <canvas ref={canvasRef} className="w-full h-full block touch-none" />
    </div>
  );
});

VrmStage.displayName = "VrmStage";
export default VrmStage;
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

interface VrmStageProps {
  emotion?: string; // Optional prop to set emotion declaratively
}

const VrmStage = forwardRef((props: VrmStageProps, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rafRef = useRef<number | null>(null);
  
  // High-performance animation refs
  const mouthOpenTarget = useRef(0);
  const currentExpression = useRef<string>("neutral");

  // ---------------------------------------------------------
  // 1. IMPERATIVE API (For StreamManager to call)
  // ---------------------------------------------------------
  useImperativeHandle(ref, () => ({
    // Triggered when audio chunks arrive from Mouth.py
    triggerMouthPop: () => {
      mouthOpenTarget.current = 0.85; 
      setTimeout(() => {
        if (mouthOpenTarget.current > 0) mouthOpenTarget.current = 0.25; 
      }, 80);
    },
    stopMouth: () => {
      mouthOpenTarget.current = 0;
    },
    // Set character expression (happy, sad, angry, neutral)
    setExpression: (name: string) => {
      currentExpression.current = name.toLowerCase();
    }
  }));

  useEffect(() => {
    let mounted = true;
    const canvas = canvasRef.current;
    if (!canvas || rendererRef.current) return;

    // --- SETUP THREE.JS ---
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
    const controllers: any = { 
      body: null, physics: null, pose: null, idle: null, face: null, hand: null, live: null 
    };

    // Handle Responsive Resize
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

    // Initial load
    (async () => {
      try {
        const loaded = (await loadVrm("/models/character.vrm")) as VRM | null;
        if (!mounted || !loaded) return;
        vrm = loaded;
        avatarRoot.add(vrm.scene);

        // Initialize Specialized Controllers
        controllers.pose = new PoseController(vrm);
        controllers.body = new BodyController(vrm);
        controllers.physics = new PhysicsController(vrm);
        controllers.live = new LiveContextController(vrm);
        controllers.face = new IdleFaceController(vrm);
        controllers.hand = new IdleHandController(vrm);
        controllers.idle = new IdleBodyController(vrm, {
          intensity: 0.9, breathe: 1.0, sway: 1.0, head: 0.9, slerp: 0.22,
        });

        vrm.update(0);
        onResize();
      } catch (e) { 
        console.error("VRM Load Error:", e); 
      }
    })();

    // --- ANIMATION LOOP ---
    const animate = () => {
      if (!mounted) return;
      rafRef.current = requestAnimationFrame(animate);
      
      const dt = clock.getDelta();
      const t = clock.getElapsedTime();

      if (vrm) {
        // 1. Run Baseline Motion (Breathing, Swaying)
        controllers.pose?.update?.(dt);
        controllers.body?.update?.(dt);
        controllers.live?.update(dt);
        controllers.idle?.update?.(dt);
        controllers.hand?.update(dt);
        controllers.physics?.applyWind?.(t);

        // 2. Handle Gaze
        const gazeScore = controllers.live?.getGazeScore?.() ?? 0;
        const visible = controllers.live?.getTrackingVisible?.() ?? false;
        controllers.face?.setLiveGaze({ strength: gazeScore, visible });
        controllers.face?.update(dt);

        // 3. OVERRIDE EXPRESSIONS (The "Soul" layer)
        if (vrm.expressionManager) {
          // A. SMOOTH LIP SYNC
          const currentA = vrm.expressionManager.getValue("aa") ?? 0;
          const nextMouthValue = THREE.MathUtils.lerp(currentA, mouthOpenTarget.current, 0.4);
          
          // Apply to shapes (compatible with VRM 0.x and 1.0)
          vrm.expressionManager.setValue("aa", nextMouthValue);
          vrm.expressionManager.setValue("ih", nextMouthValue * 0.1); // Slight width adjustment
          
          // B. EMOTIONAL OVERRIDE
          // We clear other expressions to avoid "masking"
          const expressions = ["happy", "sad", "angry", "relaxed", "surprised"];
          expressions.forEach(exp => {
            const target = exp === currentExpression.current ? 1.0 : 0.0;
            const cur = vrm!.expressionManager!.getValue(exp) ?? 0;
            vrm!.expressionManager!.setValue(exp, THREE.MathUtils.lerp(cur, target, 0.1));
          });

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
      {/* Visual guidance for eye tracking can be overlayed here */}
    </div>
  );
});

VrmStage.displayName = "VrmStage";
export default VrmStage;
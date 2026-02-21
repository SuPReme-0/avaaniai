"use client";

import React, { useEffect, useRef, forwardRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { VRM } from "@pixiv/three-vrm";

// Three.js Utils
import { loadVrm } from "@/lib/vrm/loadVrm";
import { createRenderer } from "@/lib/three/createRenderer";
import { createScene } from "@/lib/three/createScene";
import { disposeObject3D } from "@/lib/vrm/disposeThree";
import { streamManager } from "@/lib/vrm/streamManager";

// AI Controllers
import { LiveContextController } from "@/features/live/LiveContextController";
import { FaceController } from "@/features/body/FaceController";
import { BodyController } from "@/features/body/BodyController";
import { HandsController } from "@/features/body/HandsController";

export interface VrmStageProps {
  modelUrl?: string;
  userId: string;
  username: string;
}

const VrmStage = forwardRef<unknown, VrmStageProps>(({ 
  modelUrl = "/models/character.vrm", 
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    const canvas = canvasRef.current;
    if (!canvas || rendererRef.current) return;

    // 1. RENDERER SETUP
    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = createScene();
    
    // 2. ENVIRONMENT & LIGHTING (Enhanced for VRM Materials)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.0);
    keyLight.position.set(2, 2, 2);
    keyLight.castShadow = true;
    scene.add(keyLight);

    const fillLight = new THREE.PointLight(0xaaccff, 0.8);
    fillLight.position.set(-2, 1, 1);
    scene.add(fillLight);

    const clock = new THREE.Clock();
    const camera = new THREE.PerspectiveCamera(30, canvas.clientWidth / canvas.clientHeight, 0.1, 20);
    camera.position.set(0, 1.4, 1.8); // Closer portrait framing

    const avatarRoot = new THREE.Group();
    scene.add(avatarRoot);

    let vrm: VRM | null = null;
    const controllers = {
      live: null as LiveContextController | null,
      face: null as FaceController | null,
      body: null as BodyController | null,
      hands: null as HandsController | null,
    };

    // 3. RESIZE LOGIC
    const onResize = () => {
      const w = canvas.parentElement?.clientWidth || window.innerWidth;
      const h = canvas.parentElement?.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    // 4. LOAD MODEL
    (async () => {
      try {
        const loaded = (await loadVrm(modelUrl)) as VRM | null;
        if (!mounted || !loaded) return;
        vrm = loaded;

        vrm.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        avatarRoot.add(vrm.scene);

        // Init Controllers
        controllers.live = new LiveContextController(vrm);
        controllers.face = new FaceController(vrm, controllers.live);
        controllers.body = new BodyController(vrm, controllers.live);
        controllers.hands = new HandsController(vrm, controllers.live);

        controllers.live.startVideo();
        onResize();
        
        // Rotate root so character faces +Z (towards camera)
        vrm.scene.rotation.y = Math.PI; 
      } catch (e) {
        console.error("VRM Stage Error:", e);
      }
    })();

// ──────────────────────────────────────────────────────────────────────────
    // 5. WEBSOCKET SUBSCRIPTION (Real-time Data)
    // ──────────────────────────────────────────────────────────────────────────
    const unsubscribe = streamManager.subscribe((event: any) => { // Using 'any' temporarily to resolve the mismatch
      if (!controllers.live) return;
      
      // Handle Eye/Vision Tracking Data
      if (event.type === "eyes_internal") {
        controllers.live.setContext(event.data);
      } 
      
      // Handle Audio Chunks (for Lip-sync and Emotions)
      else if (event.type === "audio_chunk") {
        controllers.live.setContext({
          avatar_speaking: true,
          // If 'volume' isn't in your event, we can calculate a fallback or 
          // ensure your backend is actually sending it.
          audio_volume: event.volume ?? 0.5, 
          emotion: event.emotion,
          emotion_probs: event.emotion_scores || { [event.emotion || "neutral"]: 1.0 }
        });
      }

      // Handle the end of a response to stop mouth movement
      // We check for 'response_end' which usually exists in your overlap list
      else if (event.type === "response_end" || event.type === "audio_end") {
        controllers.live.setContext({ 
          avatar_speaking: false, 
          audio_volume: 0 
        });
      }

      // Handle System Status
      else if (event.type === "system") {
        controllers.live.setContext({ system_status: event.status });
      }
    });
    // 6. ANIMATION LOOP
    const animate = () => {
      if (!mounted) return;
      rafRef.current = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.1);

      if (vrm && controllers.live) {
        controllers.live.update(dt);
        controllers.face?.update(dt);
        controllers.body?.update(dt);
        controllers.hands?.update(dt);
        vrm.update(dt);
      }

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      mounted = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", onResize);
      unsubscribe();
      controllers.live?.stopVideo();
      if (vrm) disposeObject3D(vrm.scene);
      renderer.dispose();
    };
  }, [modelUrl]);

  return (
    <div className="w-full h-full relative bg-neutral-900">
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  );
});

VrmStage.displayName = "VrmStage";
export default VrmStage;
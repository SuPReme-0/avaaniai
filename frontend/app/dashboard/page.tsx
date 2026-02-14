"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Mic, MicOff, LogOut, Activity, Power } from "lucide-react";
import { useRouter } from "next/navigation";
import VrmStage from "@/components/vrm/VrmStage";
import { streamManager } from "@/lib/vrm/stream-manager";

export default function Dashboard() {
  const router = useRouter();
  const [isMediaActive, setIsMediaActive] = useState(false);
  const [transcript, setTranscript] = useState("System Ready");
  const [aiMode, setAiMode] = useState("idle");

  const stageRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // 1. WebSocket Setup
  useEffect(() => {
    const userJson = localStorage.getItem("user");
    if (!userJson) { router.push("/auth"); return; }
    const user = JSON.parse(userJson);

    // Bridge Backend Events -> VRM Motor Layer
    streamManager.onMouthTrigger = () => stageRef.current?.triggerMouthPop();
    streamManager.onEmotionReceived = (emo) => stageRef.current?.setExpression(emo);
    streamManager.onTextReceived = (text) => setTranscript(text);
    streamManager.onStatusChange = (status) => setAiMode(status);

    streamManager.connect(user.id, user.username);

    return () => {
      streamManager.disconnect();
      stopMedia();
    };
  }, [router]);

  // 2. Optimized Media Handling
  const startMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, frameRate: 15 },
        audio: { 
          sampleRate: 16000, 
          echoCancellation: true, 
          noiseSuppression: true 
        }
      });
      
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      // Audio Processor (Worklet)
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      await audioCtx.audioWorklet.addModule("/audio-processor.js");
      
      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "audio-processor");
      
      worklet.port.onmessage = (e) => {
        // Only send audio if we aren't currently hearing the AI (prevents echo)
        if (aiMode === "idle" || aiMode === "listening") {
          streamManager.sendAudio(e.data);
        }
      };
      
      source.connect(worklet);
      setIsMediaActive(true);
      
      // Kick off the throttled video loop
      videoLoop();
    } catch (err) {
      alert("Camera or Microphone access denied. Check browser permissions.");
    }
  };

  const stopMedia = () => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    audioCtxRef.current?.close();
    setIsMediaActive(false);
    setAiMode("idle");
  };

  // 3. Throttled Video Loop (Fixed to prevent stack overflow)
  const videoLoop = useCallback(() => {
    if (!streamRef.current?.active || !isMediaActive) return;

    if (videoRef.current && canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d", { alpha: false });
      if (ctx) {
        ctx.drawImage(videoRef.current, 0, 0, 160, 120);
        const base64 = canvasRef.current.toDataURL("image/jpeg", 0.4).split(",")[1];
        streamManager.sendVideo(base64);
      }
    }
    // 10 FPS is plenty for emotion/object tracking and saves bandwidth
    setTimeout(() => requestAnimationFrame(videoLoop), 100);
  }, [isMediaActive]);

  return (
    <main className="fixed inset-0 bg-black overflow-hidden flex flex-col items-center justify-center">
      {/* Hidden processing elements */}
      <video ref={videoRef} autoPlay muted playsInline className="hidden" />
      <canvas ref={canvasRef} width="160" height="120" className="hidden" />

      {/* VRM Stage - Layer 0 */}
      <div className="absolute inset-0 z-0">
        <VrmStage ref={stageRef} />
      </div>

      {/* Subtitles HUD - Layer 1 */}
      <div className={`absolute top-12 z-20 w-full max-w-2xl px-6 transition-all duration-700 ${transcript ? "opacity-100" : "opacity-0"}`}>
        <div className="bg-black/40 backdrop-blur-xl border border-white/10 p-6 rounded-3xl text-center shadow-2xl">
          <p className="text-white text-lg font-medium leading-relaxed tracking-wide">
            {aiMode === "thinking" ? "Avaani is thinking..." : transcript}
          </p>
        </div>
      </div>

      {/* Controls HUD - Layer 2 */}
      <div className="absolute bottom-12 z-30 flex items-center gap-6">
        <button
          onClick={() => isMediaActive ? stopMedia() : startMedia()}
          className={`group relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 active:scale-90 ${
            isMediaActive 
            ? "bg-rose-500/20 border-2 border-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.4)]" 
            : "bg-white/5 border border-white/10 hover:bg-white/10"
          }`}
        >
          <div className={`absolute inset-0 rounded-full bg-rose-400 opacity-0 group-hover:opacity-20 transition-opacity`} />
          {isMediaActive ? (
            <Activity className="text-rose-400 animate-pulse" size={32} />
          ) : (
            <Power className="text-white/60 group-hover:text-white" size={32} />
          )}
        </button>

        <button 
          onClick={() => { localStorage.clear(); router.push("/auth"); }}
          className="w-14 h-14 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/40 hover:text-rose-400 hover:bg-rose-500/10 transition-all"
        >
          <LogOut size={24} />
        </button>
      </div>

      {/* System Status Dot */}
      <div className="absolute bottom-6 right-6 flex items-center gap-2">
        <div className={`w-2 h-2 rounded-full ${aiMode !== "disconnected" ? "bg-green-500" : "bg-red-500"} animate-pulse`} />
        <span className="text-[10px] text-white/30 font-mono uppercase tracking-widest">{aiMode}</span>
      </div>
    </main>
  );
}
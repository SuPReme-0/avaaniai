"use client";

import React, { useState, useRef, useEffect } from "react";
import { Mic, MicOff, LogOut, Activity } from "lucide-react";
import { useRouter } from "next/navigation";
import VrmStage from "@/components/vrm/VrmStage";
import { streamManager } from "@/lib/vrm/stream-manager";

export default function Dashboard() {
  const router = useRouter();
  const [isMicOn, setIsMicOn] = useState(false);
  const [transcript, setTranscript] = useState("System Ready");
  
  const stageRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const userJson = localStorage.getItem("user");
    if (!userJson) { router.push("/auth"); return; }
    const user = JSON.parse(userJson);

    // Sync Backend -> VRM Stage
    streamManager.onMouthTrigger = () => stageRef.current?.triggerMouthPop();
    streamManager.onEmotionReceived = (emo) => stageRef.current?.setExpression(emo);
    streamManager.onTextReceived = (text) => setTranscript(text);

    streamManager.connect(user.id, user.username);

    return () => streamManager.disconnect();
  }, [router]);

  const startMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240, frameRate: 15 },
        audio: true
      });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;

      // Audio Worklet setup
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      await audioCtx.audioWorklet.addModule("/audio-processor.js");
      const source = audioCtx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(audioCtx, "audio-processor");
      
      worklet.port.onmessage = (e) => {
        if (isMicOn) streamManager.sendAudio(e.data);
      };
      source.connect(worklet);
      
      setIsMicOn(true);
      requestAnimationFrame(videoLoop);
    } catch (err) { alert("Media access denied."); }
  };

  const videoLoop = () => {
    if (!streamRef.current?.active) return;
    if (videoRef.current && canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      ctx?.drawImage(videoRef.current, 0, 0, 160, 120);
      const base64 = canvasRef.current.toDataURL("image/jpeg", 0.4).split(",")[1];
      streamManager.sendVideo(base64);
    }
    setTimeout(() => requestAnimationFrame(videoLoop), 100);
  };

  return (
    <main className="fixed inset-0 bg-black overflow-hidden">
      <video ref={videoRef} autoPlay muted className="hidden" />
      <canvas ref={canvasRef} width="160" height="120" className="hidden" />

      <div className="absolute inset-0 z-10">
        <VrmStage ref={stageRef} />
      </div>

      <div className="absolute top-10 left-1/2 -translate-x-1/2 z-30 w-full max-w-lg px-4">
        <div className="bg-black/60 backdrop-blur-xl p-4 rounded-2xl border border-white/10 text-center">
          <p className="text-white text-sm font-medium">{transcript}</p>
        </div>
      </div>

      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-40 flex gap-4">
        <button onClick={() => isMicOn ? setIsMicOn(false) : startMedia()} className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${isMicOn ? "bg-cyan-500 shadow-lg shadow-cyan-500/50" : "bg-white/10"}`}>
          {isMicOn ? <Activity className="text-white animate-pulse" /> : <Mic className="text-white" />}
        </button>
        <button onClick={() => { localStorage.clear(); router.push("/auth"); }} className="w-16 h-16 rounded-full bg-white/10 flex items-center justify-center text-rose-400"><LogOut /></button>
      </div>
    </main>
  );
}
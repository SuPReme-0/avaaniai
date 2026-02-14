"use client";
import React, { useState, useRef } from "react";
import Webcam from "react-webcam";
import { useRouter } from "next/navigation";
import { Camera, ArrowRight, User, Lock, Loader2 } from "lucide-react";

const POSES = ["front", "left", "right", "up", "down"];

export default function AuthPage() {
  const router = useRouter();
  const webcamRef = useRef<Webcam>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ username: "", password: "", fullName: "" });
  
  const [isCapturing, setIsCapturing] = useState(false);
  const [currentPoseIndex, setCurrentPoseIndex] = useState(0);
  const [capturedImages, setCapturedImages] = useState<File[]>([]);

  const handleCapture = async () => {
    if (!webcamRef.current) return;
    const imageSrc = webcamRef.current.getScreenshot();
    if (imageSrc) {
      const res = await fetch(imageSrc);
      const blob = await res.blob();
      const file = new File([blob], `pose_${currentPoseIndex}.jpg`, { type: "image/jpeg" });
      const nextImages = [...capturedImages, file];
      setCapturedImages(nextImages);

      if (currentPoseIndex < POSES.length - 1) {
        setCurrentPoseIndex(prev => prev + 1);
      } else {
        setIsCapturing(false);
        submitSignup(nextImages);
      }
    }
  };

  const submitSignup = async (images: File[]) => {
    setLoading(true);
    const data = new FormData();
    data.append("username", formData.username);
    data.append("password", formData.password);
    data.append("full_name", formData.fullName);
    images.forEach(img => data.append("images", img));

    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/signup`, { method: "POST", body: data });
    if (res.ok) {
      const json = await res.json();
      localStorage.setItem("user", JSON.stringify(json.user));
      router.push("/dashboard");
    } else {
      alert("Registration failed. Please try again.");
      setCapturedImages([]);
      setCurrentPoseIndex(0);
    }
    setLoading(false);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: formData.username, password: formData.password })
    });
    if (res.ok) {
      const json = await res.json();
      localStorage.setItem("user", JSON.stringify(json.user));
      router.push("/dashboard");
    } else {
      alert("Invalid credentials.");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white/5 backdrop-blur-md rounded-3xl p-8 border border-white/10 shadow-2xl">
        <h1 className="text-3xl font-bold text-center mb-8 bg-gradient-to-r from-cyan-400 to-blue-500 bg-clip-text text-transparent">Avaani AI</h1>
        
        <div className="flex bg-black/40 p-1 rounded-xl mb-6">
          <button onClick={() => setMode("login")} className={`flex-1 py-2 rounded-lg transition ${mode === "login" ? "bg-white/10" : "text-gray-500"}`}>Login</button>
          <button onClick={() => setMode("signup")} className={`flex-1 py-2 rounded-lg transition ${mode === "signup" ? "bg-white/10" : "text-gray-500"}`}>Register</button>
        </div>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative"><User className="absolute left-3 top-3 text-gray-500" size={18} /><input className="w-full pl-10 pr-4 py-3 bg-black/20 border border-white/10 rounded-xl outline-none" placeholder="Username" onChange={e => setFormData({...formData, username: e.target.value})} /></div>
            <div className="relative"><Lock className="absolute left-3 top-3 text-gray-500" size={18} /><input className="w-full pl-10 pr-4 py-3 bg-black/20 border border-white/10 rounded-xl outline-none" type="password" placeholder="Password" onChange={e => setFormData({...formData, password: e.target.value})} /></div>
            <button disabled={loading} className="w-full bg-blue-600 py-3 rounded-xl font-bold flex justify-center items-center gap-2">{loading ? <Loader2 className="animate-spin" /> : "ENTER"}</button>
          </form>
        ) : (
          <div className="space-y-4">
            {!isCapturing ? (
              <>
                <input className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-xl outline-none" placeholder="Username" onChange={e => setFormData({...formData, username: e.target.value})} />
                <input className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-xl outline-none" placeholder="Full Name" onChange={e => setFormData({...formData, fullName: e.target.value})} />
                <input className="w-full px-4 py-3 bg-black/20 border border-white/10 rounded-xl outline-none" type="password" placeholder="Password" onChange={e => setFormData({...formData, password: e.target.value})} />
                <button onClick={() => setIsCapturing(true)} className="w-full bg-cyan-600 py-3 rounded-xl font-bold">START FACE SCAN</button>
              </>
            ) : (
              <div className="text-center">
                <div className="relative rounded-xl overflow-hidden border-2 border-cyan-500 mb-4">
                  <Webcam ref={webcamRef} screenshotFormat="image/jpeg" className="w-full" />
                  <div className="absolute top-2 left-2 bg-black/50 px-2 py-1 rounded text-xs">Pose {currentPoseIndex + 1}/5</div>
                </div>
                <h3 className="text-xl font-bold mb-4">Look {POSES[currentPoseIndex].toUpperCase()}</h3>
                <button onClick={handleCapture} className="w-full bg-white text-black py-3 rounded-xl font-bold">CAPTURE</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
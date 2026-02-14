"use client";
import React, { useState, useRef } from "react";
import Webcam from "react-webcam";
import { useRouter } from "next/navigation";
import { User, Lock, Loader2, Camera, UserPlus } from "lucide-react";

const POSES = [
  { id: "front", label: "Look Straight" },
  { id: "left", label: "Turn Face Left" },
  { id: "right", label: "Turn Face Right" },
  { id: "up", label: "Tilt Face Up" },
  { id: "down", label: "Tilt Face Down" }
];

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
      const file = new File([blob], `pose_${POSES[currentPoseIndex].id}.jpg`, { type: "image/jpeg" });
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

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/signup`, { 
        method: "POST", 
        body: data 
      });
      if (res.ok) {
        const json = await res.json();
        localStorage.setItem("user", JSON.stringify(json.user));
        router.push("/dashboard");
      } else {
        alert("Signup failed. Ensure username is unique.");
        setIsCapturing(false);
        setCapturedImages([]);
        setCurrentPoseIndex(0);
      }
    } catch (err) {
      alert("Backend connection error. Is Render awake?");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
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
    } catch (err) {
      alert("Login server unreachable.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md bg-white/5 backdrop-blur-2xl rounded-[2.5rem] p-10 border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-extrabold tracking-tighter bg-gradient-to-br from-white to-white/40 bg-clip-text text-transparent">AVAANI</h1>
          <p className="text-white/40 text-sm mt-2 font-medium tracking-widest uppercase">Real-time AI Core</p>
        </div>
        
        <div className="flex bg-black/40 p-1.5 rounded-2xl mb-8 border border-white/5">
          <button onClick={() => setMode("login")} className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${mode === "login" ? "bg-white/10 text-white shadow-xl" : "text-white/30 hover:text-white/60"}`}>LOGIN</button>
          <button onClick={() => setMode("signup")} className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all ${mode === "signup" ? "bg-white/10 text-white shadow-xl" : "text-white/30 hover:text-white/60"}`}>REGISTER</button>
        </div>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative group">
              <User className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-cyan-400 transition-colors" size={18} />
              <input required className="w-full pl-12 pr-4 py-4 bg-black/40 border border-white/10 rounded-2xl outline-none focus:border-cyan-500/50 transition-all placeholder:text-white/10" placeholder="Username" onChange={e => setFormData({...formData, username: e.target.value})} />
            </div>
            <div className="relative group">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-cyan-400 transition-colors" size={18} />
              <input required className="w-full pl-12 pr-4 py-4 bg-black/40 border border-white/10 rounded-2xl outline-none focus:border-cyan-500/50 transition-all placeholder:text-white/10" type="password" placeholder="Password" onChange={e => setFormData({...formData, password: e.target.value})} />
            </div>
            <button disabled={loading} className="w-full bg-white text-black py-4 rounded-2xl font-bold hover:bg-cyan-400 transition-all active:scale-[0.98] flex justify-center items-center gap-2">
              {loading ? <Loader2 className="animate-spin" /> : "ENTER SYSTEM"}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            {!isCapturing ? (
              <>
                <input required className="w-full px-5 py-4 bg-black/40 border border-white/10 rounded-2xl outline-none focus:border-cyan-500/50 transition-all" placeholder="Desired Username" onChange={e => setFormData({...formData, username: e.target.value})} />
                <input required className="w-full px-5 py-4 bg-black/40 border border-white/10 rounded-2xl outline-none focus:border-cyan-500/50 transition-all" placeholder="Your Full Name" onChange={e => setFormData({...formData, fullName: e.target.value})} />
                <input required className="w-full px-5 py-4 bg-black/40 border border-white/10 rounded-2xl outline-none focus:border-cyan-500/50 transition-all" type="password" placeholder="Secure Password" onChange={e => setFormData({...formData, password: e.target.value})} />
                <button onClick={() => setIsCapturing(true)} className="w-full bg-cyan-600 py-4 rounded-2xl font-bold hover:bg-cyan-500 transition-all flex items-center justify-center gap-2">
                  <Camera size={20} /> START BIOMETRIC SCAN
                </button>
              </>
            ) : (
              <div className="text-center animate-in fade-in zoom-in duration-300">
                <div className="relative rounded-[2rem] overflow-hidden border-2 border-cyan-500/50 mb-6 shadow-[0_0_30px_rgba(34,211,238,0.2)]">
                  <Webcam ref={webcamRef} screenshotFormat="image/jpeg" className="w-full scale-x-[-1]" />
                  <div className="absolute top-4 left-4 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full text-[10px] font-bold tracking-widest uppercase">
                    Scan {currentPoseIndex + 1} / 5
                  </div>
                </div>
                <p className="text-cyan-400 font-bold text-lg mb-6 tracking-tight">{POSES[currentPoseIndex].label}</p>
                <button onClick={handleCapture} className="w-full bg-white text-black py-4 rounded-2xl font-bold active:scale-95 transition-transform">CAPTURE POSE</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
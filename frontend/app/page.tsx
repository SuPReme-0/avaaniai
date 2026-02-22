"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  Loader2, User, Lock, ScanFace, CheckCircle2, AlertCircle,
  ChevronLeft, Power, Sparkles, Mic, MicOff, Waves
} from "lucide-react";
import VrmStage from "@/components/vrm/VrmStage";
import { streamManager, StreamEvent } from "@/lib/vrm/streamManager";

// ============================================================================
// CONFIGURATION
// ============================================================================
type AuthMode = "LOGIN" | "SIGNUP";
type AppState = "HOME" | "AUTH" | "LOADING" | "READY" | "LIVE";
type FaceAngle = "CENTER" | "LEFT" | "RIGHT" | "UP" | "DOWN";

const ANGLE_SEQUENCE: FaceAngle[] = ["CENTER", "LEFT", "RIGHT", "UP", "DOWN"];
const ANGLE_INSTRUCTIONS: Record<FaceAngle, string> = {
  CENTER: "ALIGN FACE CENTER",
  LEFT: "ROTATE HEAD LEFT",
  RIGHT: "ROTATE HEAD RIGHT",
  UP: "TILT HEAD UP",
  DOWN: "TILT HEAD DOWN",
};

export default function Home() {
  // --- APP STATE ---
  const [appState, setAppState] = useState<AppState>("HOME");
  const [user, setUser] = useState<{ id: string; username: string; fullName: string } | null>(null);

  // --- AUTH FORM ---
  const [authMode, setAuthMode] = useState<AuthMode>("LOGIN");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // --- REAL-TIME CHECKER ---
  const [isCheckingUser, setIsCheckingUser] = useState(false);
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null);

  // --- BIOMETRICS ---
  const [isEnrolling, setIsEnrolling] = useState(false);
  const [currentAngleIdx, setCurrentAngleIdx] = useState(0);
  const [capturedBlobs, setCapturedBlobs] = useState<Blob[]>([]);
  const isCheckingAngleRef = useRef(false); 

  // --- LIVE CHAT STATE (CINEMATIC SUBTITLES) ---
  const [botSubtitle, setBotSubtitle] = useState<string>(""); 
  const [userSubtitle, setUserSubtitle] = useState<string>(""); 
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isStandby, setIsStandby] = useState(false);

  // --- REFS ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const subtitleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingBotSubtitle = useRef<string>(""); // ⚡ Holds text until audio plays

  // =========================================================================
  // USERNAME CHECKER
  // =========================================================================
  useEffect(() => {
    if (authMode !== "SIGNUP" || !username || username.length < 3) {
      setUsernameAvailable(null);
      return;
    }
    const timer = setTimeout(async () => {
      setIsCheckingUser(true);
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/auth/check/${username}`);
        const data = await res.json();
        setUsernameAvailable(data.available);
      } catch {
        setUsernameAvailable(null);
      } finally {
        setIsCheckingUser(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [username, authMode]);

  // =========================================================================
  // BIOMETRIC AUTO-CAPTURE LOOP
  // =========================================================================
  useEffect(() => {
    let stream: MediaStream | null = null;
    if (isEnrolling) {
      navigator.mediaDevices
        .getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } })
        .then((s) => {
          stream = s;
          if (videoRef.current) videoRef.current.srcObject = stream;
        })
        .catch(() => setError("Camera Access Denied"));
    }
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [isEnrolling]);

  useEffect(() => {
    if (!isEnrolling || currentAngleIdx >= ANGLE_SEQUENCE.length) return;

    let isActive = true;
    const targetAngle = ANGLE_SEQUENCE[currentAngleIdx];

    const captureInterval = setInterval(async () => {
      if (!isActive || !videoRef.current || !canvasRef.current || isCheckingAngleRef.current) return;
      isCheckingAngleRef.current = true;

      const ctx = canvasRef.current.getContext("2d");
      ctx?.drawImage(videoRef.current, 0, 0, 640, 480);

      canvasRef.current.toBlob(async (blob) => {
        if (!blob) {
          isCheckingAngleRef.current = false;
          return;
        }

        const formData = new FormData();
        formData.append("angle", targetAngle);
        formData.append("image", blob);

        try {
          const res = await fetch(
            `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/auth/validate-face`,
            { method: "POST", body: formData }
          );

          if (res.ok && isActive) {
            setCapturedBlobs((prev) => [...prev, blob]);
            setCurrentAngleIdx((prev) => prev + 1);
            setTimeout(() => { isCheckingAngleRef.current = false; }, 1000); 
          } else {
             isCheckingAngleRef.current = false;
          }
        } catch (err) {
          isCheckingAngleRef.current = false;
        }
      }, "image/jpeg", 0.7);
    }, 400); 

    return () => {
      isActive = false;
      clearInterval(captureInterval);
      isCheckingAngleRef.current = false;
    };
  }, [isEnrolling, currentAngleIdx]);

  const resetEnrollment = () => {
    setIsEnrolling(false);
    setCapturedBlobs([]);
    setCurrentAngleIdx(0);
    isCheckingAngleRef.current = false;
  };

  // =========================================================================
  // API HANDLERS & TIMERS
  // =========================================================================
  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setIsLoading(true);
    setError("");
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/auth/login`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Login failed");
      
      setUser({
        id: data.user.id,
        username: data.user.username,
        fullName: data.user.full_name,
      });

      localStorage.setItem("avaani_token", data.access_token);
      
      // ⚡ The 2-Second Cinematic Loading Phase
      setAppState("LOADING");
      setTimeout(() => {
        setAppState("READY");
      }, 2000);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (capturedBlobs.length < 5) {
        setError("Please complete biometric scan first.");
        return;
    }

    setIsLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("username", username);
      formData.append("password", password);
      formData.append("full_name", fullName);
      capturedBlobs.forEach((blob, i) =>
        formData.append("face_images", blob, `pose_${i}.jpg`)
      );

      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/auth/signup`,
        { method: "POST", body: formData }
      );
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Signup failed");
      
      await handleLogin();
    } catch (err: any) {
      setError(err.message);
      resetEnrollment();
    } finally {
      setIsLoading(false);
    }
  };

  // =========================================================================
  // START LIVE SESSION
  // =========================================================================
  const startExperience = async () => {
    if (!user) return;
    
    const token = localStorage.getItem("avaani_token");
    streamManager.connect(user.id, user.username, token || undefined); 
    
    await streamManager.startMicrophone();
    setIsMicActive(true);
    setAppState("LIVE");

    setBotSubtitle("");
    setUserSubtitle("");
    
    setTimeout(() => {
      // Direct assignment for the initial greeting (no buffer needed)
      setBotSubtitle(`Hello ${user.fullName.split(" ")[0]}. I'm here.`);
      clearSubtitleAfterDelay();
    }, 1200);
  };

  const clearSubtitleAfterDelay = () => {
    if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
    subtitleTimeoutRef.current = setTimeout(() => {
      setBotSubtitle("");
      setUserSubtitle("");
      setIsThinking(false);
    }, 6000); // Clear screen after 6 seconds of silence to keep view clean
  };

  // =========================================================================
  // STREAM MANAGER INTEGRATION (PERFECT SYNC)
  // =========================================================================
  useEffect(() => {
    if (appState !== "LIVE") return;

    // ⚡ SYNC MAGIC: Only show the text when the mouth actually starts moving
    streamManager.onMouthMove = () => {
        setIsAvatarSpeaking(true);
        setIsThinking(false);
        if (pendingBotSubtitle.current) {
            setBotSubtitle(pendingBotSubtitle.current);
            pendingBotSubtitle.current = ""; // Clear buffer
            clearSubtitleAfterDelay();
        }
    };
    
    streamManager.onMouthStop = () => {
        setIsAvatarSpeaking(false);
        clearSubtitleAfterDelay();
    };

    const unsubscribe = streamManager.subscribe((event: StreamEvent) => {
      switch (event.type) {
        case "status":
          if (event.mode === "connected") setIsConnected(true);
          if (event.mode === "disconnected") setIsConnected(false);
          if (event.mode === "thinking") setIsThinking(true);
          break;
        case "response_start":
          // ⚡ Buffer the text. Don't show it yet!
          pendingBotSubtitle.current = event.text || "";
          setUserSubtitle(""); 
          setIsThinking(false);
          if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
          break;
        case "user_transcript":
          if (event.text) {
            setUserSubtitle(event.text);
            setBotSubtitle(""); 
            pendingBotSubtitle.current = "";
            setIsThinking(true); // User finished speaking, bot is thinking
            clearSubtitleAfterDelay();
          }
          break;
      }
    });

    return () => {
      unsubscribe();
      streamManager.stopMicrophone();
      if (subtitleTimeoutRef.current) clearTimeout(subtitleTimeoutRef.current);
    };
  }, [appState]);

  const toggleStandby = () => {
    if (isStandby) {
      streamManager.startMicrophone();
      setIsStandby(false);
      setIsMicActive(true);
    } else {
      streamManager.stopMicrophone();
      setIsStandby(true); 
      setIsMicActive(false);
      setIsThinking(false);
    }
  };

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <main className="fixed inset-0 bg-[#020202] overflow-hidden font-sans selection:bg-cyan-500/30 text-white">
      
      {/* --- LAYER 0: VRM WORLD (Always mounted for seamless transitions) --- */}
      <div
        className={`absolute inset-0 z-0 transition-all duration-[2000ms] ease-out ${
          appState === "LIVE" ? "opacity-100 scale-100" : "opacity-0 blur-xl scale-110"
        }`}
      >
        <VrmStage 
            modelUrl="/models/character.vrm" 
            userId={user?.id || "guest"} 
            username={user?.username || "Stranger"} 
        />
        
        {/* Cinematic Overlays */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,#000_100%)] pointer-events-none opacity-80" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(10,10,10,0)_50%,rgba(0,0,0,0.4)_50%),linear-gradient(90deg,rgba(255,0,0,0.02)_1px,transparent_1px)] bg-[length:100%_4px,40px_100%] pointer-events-none opacity-30 mix-blend-overlay" />
        
        {/* Heavy Vignette for Live Mode to focus on the Avatar */}
        {appState === "LIVE" && (
            <div className="absolute inset-0 shadow-[inset_0_0_200px_rgba(0,0,0,0.95)] pointer-events-none" />
        )}
      </div>

      {/* --- SCENE 1: HOME SCREEN --- */}
      {appState === "HOME" && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-1000">
          <div className="text-center space-y-8 animate-in slide-in-from-bottom-8 duration-1000">
            <h1 className="text-6xl md:text-8xl font-thin tracking-[0.3em] text-white drop-shadow-[0_0_40px_rgba(255,255,255,0.2)]">
              AVAANI
            </h1>
            <p className="text-white/40 text-xs md:text-sm tracking-[0.6em] font-light">
              COGNITIVE COMPANION
            </p>
            <div className="pt-16">
              <button
                onClick={() => setAppState("AUTH")}
                className="group relative px-12 py-4 bg-transparent border border-white/20 text-white font-light tracking-[0.2em] text-sm overflow-hidden rounded-full hover:border-white/50 transition-colors duration-500"
              >
                <div className="absolute inset-0 bg-white/5 translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out" />
                <span className="relative z-10">INITIALIZE</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- SCENE 2: AUTHENTICATION --- */}
      {appState === "AUTH" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xl animate-in fade-in duration-700">
          <div className="w-full max-w-md bg-[#0a0a0a] border border-white/5 p-8 rounded-3xl shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-white/30 to-transparent opacity-30 group-hover:opacity-100 transition-opacity duration-700" />
            
            {!isEnrolling && (
              <div className="text-center mb-10">
                <h2 className="text-2xl font-thin tracking-[0.2em] text-white">ACCESS</h2>
                <p className="text-white/30 text-[10px] tracking-[0.2em] mt-2">
                  SECURE NEURAL HANDSHAKE
                </p>
              </div>
            )}
            
            {error && (
              <div className="mb-6 bg-red-950/30 border border-red-500/20 text-red-400 p-3 rounded-lg text-xs flex items-center gap-2 font-light">
                <AlertCircle size={14} /> {error}
              </div>
            )}
            
            {isEnrolling ? (
              <div className="space-y-6 animate-in zoom-in duration-300">
                <button
                  onClick={resetEnrollment}
                  className="absolute top-6 left-6 text-white/30 hover:text-white transition-colors"
                >
                  <ChevronLeft size={20} />
                </button>
                <div className="relative w-full aspect-[4/3] bg-black rounded-2xl overflow-hidden border border-white/10">
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    className="w-full h-full object-cover transform scale-x-[-1] opacity-60 filter contrast-125 grayscale-[30%]"
                  />
                  <canvas ref={canvasRef} width="640" height="480" className="hidden" />
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <div className="w-48 h-64 border border-white/20 rounded-[40%] relative">
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-[1px] bg-white/50" />
                      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-16 h-[1px] bg-white/50" />
                      <div className="absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 w-[1px] h-16 bg-white/50" />
                      <div className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-[1px] h-16 bg-white/50" />
                    </div>
                    <div className="absolute bottom-6 bg-black/60 backdrop-blur-md px-4 py-2 rounded-full text-white font-light text-[10px] tracking-widest border border-white/10 animate-pulse">
                      {ANGLE_INSTRUCTIONS[ANGLE_SEQUENCE[currentAngleIdx]]}
                    </div>
                  </div>
                </div>
                <div className="w-full bg-white/5 h-[2px] rounded-full overflow-hidden">
                  <div
                    className="bg-white/80 h-full transition-all duration-300"
                    style={{ width: `${(currentAngleIdx / 5) * 100}%` }}
                  />
                </div>
              </div>
            ) : (
              <form onSubmit={authMode === "LOGIN" ? handleLogin : handleSignup} className="space-y-5">
                <div className="flex bg-white/5 rounded-lg p-1 mb-6">
                  <button
                    type="button"
                    onClick={() => setAuthMode("LOGIN")}
                    className={`flex-1 py-2.5 text-[10px] tracking-widest rounded-md transition-all ${
                      authMode === "LOGIN" ? "bg-white/10 text-white shadow-sm" : "text-white/40 hover:text-white"
                    }`}
                  >
                    LOGIN
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode("SIGNUP")}
                    className={`flex-1 py-2.5 text-[10px] tracking-widest rounded-md transition-all ${
                      authMode === "SIGNUP" ? "bg-white/10 text-white shadow-sm" : "text-white/40 hover:text-white"
                    }`}
                  >
                    REGISTER
                  </button>
                </div>
                
                <div className="space-y-4">
                  {authMode === "SIGNUP" && (
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="USERNAME"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                        className={`w-full bg-black/50 border rounded-xl p-4 text-xs tracking-wider outline-none transition-all font-light ${
                          usernameAvailable === false ? "border-red-500/50 focus:border-red-500" : "border-white/10 focus:border-white/30"
                        }`}
                      />
                      <div className="absolute right-4 top-4">
                        {isCheckingUser ? (
                          <Loader2 size={16} className="animate-spin text-white/30" />
                        ) : usernameAvailable === true ? (
                          <CheckCircle2 size={16} className="text-white/50" />
                        ) : null}
                      </div>
                    </div>
                  )}
                  {authMode === "LOGIN" && (
                    <div className="relative">
                      <User size={16} className="absolute left-4 top-4 text-white/20" />
                      <input
                        type="text"
                        placeholder="IDENTITY ID"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="w-full bg-black/50 border border-white/10 rounded-xl p-4 pl-12 text-xs tracking-wider outline-none focus:border-white/30 transition-colors font-light"
                      />
                    </div>
                  )}
                  <div className="relative">
                    <Lock size={16} className="absolute left-4 top-4 text-white/20" />
                    <input
                      type="password"
                      placeholder="ACCESS KEY"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-black/50 border border-white/10 rounded-xl p-4 pl-12 text-xs tracking-wider outline-none focus:border-white/30 transition-colors font-light"
                    />
                  </div>
                  {authMode === "SIGNUP" && (
                    <input
                      type="text"
                      placeholder="DISPLAY NAME"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full bg-black/50 border border-white/10 rounded-xl p-4 text-xs tracking-wider outline-none focus:border-white/30 transition-colors font-light"
                    />
                  )}
                </div>

                <div className="pt-4">
                  {authMode === "LOGIN" ? (
                    <button disabled={isLoading} className="w-full bg-white text-black font-medium py-4 rounded-xl hover:bg-gray-200 transition-all text-[10px] tracking-[0.2em] flex justify-center items-center h-12">
                      {isLoading ? <Loader2 className="animate-spin" size={16} /> : "AUTHENTICATE"}
                    </button>
                  ) : capturedBlobs.length === 5 ? (
                    <button disabled={isLoading} className="w-full bg-white text-black font-medium py-4 rounded-xl hover:bg-gray-200 transition-all text-[10px] tracking-[0.2em] flex justify-center items-center gap-2 h-12">
                      {isLoading ? <Loader2 className="animate-spin" size={16} /> : "CREATE IDENTITY"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIsEnrolling(true)}
                      disabled={usernameAvailable === false || !username}
                      className="w-full border border-dashed border-white/20 py-4 rounded-xl text-[10px] text-white/50 hover:text-white hover:border-white/50 transition-all tracking-[0.2em] flex items-center justify-center gap-2 h-12 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ScanFace size={16} /> CALIBRATE BIOMETRICS
                    </button>
                  )}
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* --- SCENE 3: LOADING WARMUP --- */}
      {appState === "LOADING" && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-xl animate-in fade-in duration-500">
          <div className="relative flex items-center justify-center mb-8">
             <div className="w-16 h-16 border-t-2 border-l-2 border-white/20 rounded-full animate-spin absolute" />
             <div className="w-12 h-12 border-r-2 border-b-2 border-white/40 rounded-full animate-spin absolute" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
             <Sparkles size={20} className="text-white/60 animate-pulse" />
          </div>
          <p className="text-white/40 text-[10px] tracking-[0.4em] font-light animate-pulse">
            SYNCHRONIZING NEURAL NETWORKS
          </p>
        </div>
      )}

      {/* --- SCENE 4: READY --- */}
      {appState === "READY" && user && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-1000">
          <div className="text-center space-y-10 mt-32 animate-in slide-in-from-bottom-8 duration-1000">
            <div>
              <h1 className="text-3xl font-thin tracking-[0.2em] text-white">IDENTITY VERIFIED</h1>
              <p className="text-white/40 text-[10px] tracking-[0.3em] font-light mt-3">
                WELCOME BACK, {user.fullName.toUpperCase()}
              </p>
            </div>
            <button
              onClick={startExperience}
              className="group relative px-10 py-4 bg-white/5 backdrop-blur-md border border-white/20 text-white font-light text-[10px] tracking-[0.2em] rounded-full hover:bg-white hover:text-black transition-all duration-500 overflow-hidden"
            >
              <div className="absolute inset-0 bg-white translate-y-full group-hover:translate-y-0 transition-transform duration-500 ease-out z-0" />
              <span className="relative z-10">ESTABLISH CONNECTION</span>
            </button>
          </div>
        </div>
      )}

      {/* --- SCENE 5: LIVE CONVERSATION (Cinematic, Clean UI) --- */}
      {appState === "LIVE" && (
        <div className="absolute inset-0 z-40 flex flex-col justify-between pointer-events-none p-6 md:p-12 animate-in fade-in duration-1000">
          
          {/* Top Status Bar */}
          <div className="flex justify-between items-start opacity-40">
            <div className="flex items-center gap-3">
              <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-white animate-pulse" : "bg-red-500"}`} />
              <span className="text-[9px] tracking-[0.3em] font-light">
                {isConnected ? "LINK ACTIVE" : "RECONNECTING"}
              </span>
            </div>
          </div>

          {/* Bottom Interaction Area */}
          <div className="flex flex-col items-center w-full max-w-4xl mx-auto">
            
            {/* Stable Subtitle Container */}
            <div className="w-full min-h-[100px] flex flex-col justify-end items-center mb-10 drop-shadow-[0_4px_12px_rgba(0,0,0,0.9)]">
              {userSubtitle ? (
                <div className="flex flex-col items-center gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500">
                  <p className="text-cyan-100/70 text-lg md:text-xl font-light tracking-wide italic">
                    "{userSubtitle}"
                  </p>
                </div>
              ) : botSubtitle ? (
                <p className="text-white text-xl md:text-3xl font-thin tracking-wide animate-in fade-in slide-in-from-bottom-2 duration-500 leading-relaxed text-center">
                  {botSubtitle}
                </p>
              ) : isThinking ? (
                <div className="flex gap-2 items-center opacity-40 animate-pulse">
                  <div className="w-1.5 h-1.5 rounded-full bg-white/80" />
                  <div className="w-1.5 h-1.5 rounded-full bg-white/80" style={{ animationDelay: "0.2s" }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-white/80" style={{ animationDelay: "0.4s" }} />
                </div>
              ) : null}
            </div>

            {/* Elegant Controls */}
            <div className="flex items-center gap-6 pointer-events-auto">
              <button
                onClick={toggleStandby}
                className={`group relative flex items-center justify-center w-14 h-14 rounded-full backdrop-blur-xl border transition-all duration-500 ${
                  !isMicActive 
                    ? "bg-white/5 border-white/20 text-white/50" 
                    : "bg-white/10 border-white/30 text-white hover:bg-white/20 hover:scale-105 shadow-[0_0_30px_rgba(255,255,255,0.1)]"
                }`}
              >
                {isMicActive ? (
                  <>
                    <Mic size={20} className="relative z-10" />
                    {/* Organic breathing ring when mic is active */}
                    <div className="absolute inset-[-4px] border border-white/20 rounded-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite]" />
                  </>
                ) : (
                  <MicOff size={20} />
                )}
              </button>
            </div>
          </div>

        </div>
      )}
    </main>
  );
}
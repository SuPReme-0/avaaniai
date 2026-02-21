"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Loader2, User, Lock, ScanFace, CheckCircle2, AlertCircle,
  ChevronLeft, Power
} from "lucide-react";
import VrmStage from "@/components/vrm/VrmStage";
import { streamManager, StreamEvent } from "@/lib/vrm/streamManager";

// ============================================================================
// CONFIGURATION
// ============================================================================
type AuthMode = "LOGIN" | "SIGNUP";
type AppState = "AUTH" | "READY" | "LIVE";
type FaceAngle = "CENTER" | "LEFT" | "RIGHT" | "UP" | "DOWN";

const ANGLE_SEQUENCE: FaceAngle[] = ["CENTER", "LEFT", "RIGHT", "UP", "DOWN"];
const ANGLE_INSTRUCTIONS: Record<FaceAngle, string> = {
  CENTER: "ALIGN FACE CENTER",
  LEFT: "ROTATE HEAD LEFT",
  RIGHT: "ROTATE HEAD RIGHT",
  UP: "TILT HEAD UP",
  DOWN: "TILT HEAD DOWN",
};

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export default function Home() {
  // --- APP STATE ---
  const [appState, setAppState] = useState<AppState>("AUTH");
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
  const isCheckingAngleRef = useRef(false); // ⚡ Prevents API spam

  // --- LIVE CHAT STATE ---
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentResponse, setCurrentResponse] = useState<string>(""); 
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [isMicActive, setIsMicActive] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [sessionTime, setSessionTime] = useState(0);
  const [isStandby, setIsStandby] = useState(false);

  // --- REFS ---
  const stageRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, currentResponse]);

  useEffect(() => {
    if (appState === "LIVE" && !isStandby) {
      const timer = setInterval(() => setSessionTime((t) => t + 1), 1000);
      return () => clearInterval(timer);
    }
  }, [appState, isStandby]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
    const secs = (seconds % 60).toString().padStart(2, "0");
    return `${mins}:${secs}`;
  };

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
    // Stop if not enrolling or if all angles are captured
    if (!isEnrolling || currentAngleIdx >= ANGLE_SEQUENCE.length) return;

    let isActive = true;
    const targetAngle = ANGLE_SEQUENCE[currentAngleIdx];

    // ⚡ FIX: Use an interval instead of recursive timeouts to prevent stack buildup
    const captureInterval = setInterval(async () => {
      if (!isActive || !videoRef.current || !canvasRef.current || isCheckingAngleRef.current) return;
      
      // Lock the API call
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
            // Success! Save the blob and advance index
            setCapturedBlobs((prev) => [...prev, blob]);
            setCurrentAngleIdx((prev) => prev + 1);
            
            // Give user a brief pause before checking next angle
            setTimeout(() => {
                isCheckingAngleRef.current = false;
            }, 1000); 
          } else {
             // Failed check, unlock immediately for next frame
             isCheckingAngleRef.current = false;
          }
        } catch (err) {
          console.error("Validation error:", err);
          isCheckingAngleRef.current = false;
        }
      }, "image/jpeg", 0.7);
    }, 400); // Check 2.5 times a second

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
  // API HANDLERS
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

      // Pass token to stream manager for authentication
      // streamManager handles connection upon startExperience
      localStorage.setItem("avaani_token", data.access_token);
      
      setAppState("READY");
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
      
      // Auto-login after successful signup
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
    
    // Resume audio context inside user interaction event
    await streamManager.resumeAudioContext();
    
    // Pass JWT token for backend auth verification
    const token = localStorage.getItem("avaani_token");
    streamManager.connect(user.id, user.username); 
    
    await streamManager.startMicrophone();
    setIsMicActive(true);
    setAppState("LIVE");

    // Clear old messages and set greeting
    setMessages([]);
    setTimeout(() => {
      setMessages([{
        id: Date.now().toString(),
        role: "assistant",
        text: `Hello ${user.fullName.split(" ")[0]}. I'm here whenever you need me.`,
        timestamp: Date.now(),
      }]);
    }, 1200);
  };

  // =========================================================================
  // STREAM MANAGER INTEGRATION
  // =========================================================================
  useEffect(() => {
    if (appState !== "LIVE") return;

    // Visual lip-sync flag mapping
    streamManager.onMouthMove = () => setIsAvatarSpeaking(true);
    streamManager.onMouthStop = () => setIsAvatarSpeaking(false);

    const unsubscribe = streamManager.subscribe((event: StreamEvent) => {
      switch (event.type) {
        case "response_start":
          setCurrentResponse(event.text || "");
          break;
        case "audio_chunk":
          // If we receive audio but no start event fired, ensure speaking flag is true
          setIsAvatarSpeaking(true); 
          break;
        case "response_end":
          if (currentResponse) {
            setMessages((prev) => [...prev, {
                id: Date.now().toString(),
                role: "assistant",
                text: currentResponse,
                timestamp: Date.now(),
            }]);
            setCurrentResponse("");
          }
          break;
        case "status":
          if (event.mode === "connected") setIsConnected(true);
          if (event.mode === "disconnected") setIsConnected(false);
          break;
        case "user_transcript":
          if (event.text) {
            setMessages((prev) => [...prev, {
                id: Date.now().toString(),
                role: "user",
                text: event.text,
                timestamp: Date.now(),
            }]);
          }
          break;
      }
    });

    return () => {
      unsubscribe();
      streamManager.stopMicrophone();
    };
  }, [appState]);

  const toggleStandby = () => {
    if (isStandby) {
      streamManager.startMicrophone();
      setIsStandby(false);
      setIsMicActive(true);
    } else {
      streamManager.stopMicrophone();
      setIsStandby(false); // Still visually active but mic is off
      setIsMicActive(false);
    }
  };

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <main className="fixed inset-0 bg-black overflow-hidden font-sans selection:bg-cyan-500/30 text-white">
      
      {/* --- LAYER 0: VRM WORLD --- */}
      <div
        className={`absolute inset-0 z-0 transition-all duration-1000 ${
          appState === "AUTH" ? "opacity-30 blur-md scale-105" : "opacity-100 scale-100"
        }`}
      >
        {/* ⚡ FIX: Mount VrmStage unconditionally so it loads during login */}
        <VrmStage 
            modelUrl="/models/character.vrm" 
            userId={user?.id || "guest"} 
            username={user?.username || "Stranger"} 
        />
        
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,#000_100%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(10,10,10,0)_50%,rgba(0,0,0,0.4)_50%),linear-gradient(90deg,rgba(255,0,0,0.03)_1px,transparent_1px)] bg-[length:100%_4px,40px_100%] pointer-events-none opacity-30" />
      </div>

      {/* --- SCENE 1: AUTHENTICATION --- */}
      {appState === "AUTH" && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md">
          <div className="w-full max-w-md bg-black/80 border border-white/10 p-8 rounded-2xl shadow-[0_0_50px_rgba(0,255,255,0.1)] relative overflow-hidden group">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50 group-hover:opacity-100 transition-opacity" />
            
            {!isEnrolling && (
              <div className="text-center mb-8">
                <h1 className="text-4xl font-thin tracking-[0.2em] text-white">AVAANI</h1>
                <p className="text-cyan-500/50 text-[10px] tracking-[0.4em] mt-2">
                  NEURAL INTERFACE LINK
                </p>
              </div>
            )}
            
            {error && (
              <div className="mb-4 bg-red-900/20 border border-red-500/30 text-red-400 p-3 rounded text-xs flex items-center gap-2">
                <AlertCircle size={14} /> {error}
              </div>
            )}
            
            {isEnrolling ? (
              <div className="space-y-4 animate-in zoom-in duration-300">
                <button
                  onClick={resetEnrollment}
                  className="absolute top-4 left-4 text-white/30 hover:text-white transition-colors"
                >
                  <ChevronLeft size={20} />
                </button>
                <div className="relative w-full aspect-[4/3] bg-black rounded-lg overflow-hidden border border-cyan-500/30 shadow-[0_0_30px_rgba(6,182,212,0.15)]">
                  <video
                    ref={videoRef}
                    autoPlay
                    muted
                    className="w-full h-full object-cover transform scale-x-[-1] opacity-80"
                  />
                  <canvas ref={canvasRef} width="640" height="480" className="hidden" />
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <div className="w-48 h-64 border-2 border-cyan-500/50 rounded-[40%] relative">
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-20 h-1 bg-black" />
                      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-20 h-1 bg-black" />
                      <div className="absolute top-1/2 left-0 -translate-x-1/2 -translate-y-1/2 w-1 h-20 bg-black" />
                      <div className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-1 h-20 bg-black" />
                    </div>
                    <div className="absolute bottom-4 bg-black/60 backdrop-blur px-4 py-1 rounded text-cyan-400 font-bold text-xs tracking-widest border border-cyan-500/20 animate-pulse">
                      {ANGLE_INSTRUCTIONS[ANGLE_SEQUENCE[currentAngleIdx]]}
                    </div>
                  </div>
                </div>
                <div className="w-full bg-white/5 h-1 rounded-full overflow-hidden">
                  <div
                    className="bg-cyan-500 h-full transition-all duration-300"
                    style={{ width: `${(currentAngleIdx / 5) * 100}%` }}
                  />
                </div>
              </div>
            ) : (
              <form onSubmit={authMode === "LOGIN" ? handleLogin : handleSignup} className="space-y-5">
                <div className="flex bg-white/5 rounded p-1">
                  <button
                    type="button"
                    onClick={() => setAuthMode("LOGIN")}
                    className={`flex-1 py-2 text-xs font-bold rounded transition-all ${
                      authMode === "LOGIN" ? "bg-white/10 text-white" : "text-white/30 hover:text-white"
                    }`}
                  >
                    LOGIN
                  </button>
                  <button
                    type="button"
                    onClick={() => setAuthMode("SIGNUP")}
                    className={`flex-1 py-2 text-xs font-bold rounded transition-all ${
                      authMode === "SIGNUP" ? "bg-white/10 text-white" : "text-white/30 hover:text-white"
                    }`}
                  >
                    REGISTER
                  </button>
                </div>
                
                <div className="space-y-3">
                  {authMode === "SIGNUP" && (
                    <div className="relative">
                      <input
                        type="text"
                        placeholder="USERNAME"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                        className={`w-full bg-black/50 border rounded p-3 text-xs tracking-wider outline-none transition-all ${
                          usernameAvailable === false ? "border-red-500/50" : "border-white/10 focus:border-cyan-500/50"
                        }`}
                      />
                      <div className="absolute right-3 top-3">
                        {isCheckingUser ? (
                          <Loader2 size={14} className="animate-spin text-white/30" />
                        ) : usernameAvailable === true ? (
                          <CheckCircle2 size={14} className="text-green-500" />
                        ) : null}
                      </div>
                    </div>
                  )}
                  {authMode === "LOGIN" && (
                    <div className="relative">
                      <User size={14} className="absolute left-3 top-3.5 text-white/30" />
                      <input
                        type="text"
                        placeholder="IDENTITY ID"
                        required
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="w-full bg-black/50 border border-white/10 rounded p-3 pl-10 text-xs tracking-wider outline-none focus:border-cyan-500/50"
                      />
                    </div>
                  )}
                  <div className="relative">
                    <Lock size={14} className="absolute left-3 top-3.5 text-white/30" />
                    <input
                      type="password"
                      placeholder="ACCESS KEY"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-black/50 border border-white/10 rounded p-3 pl-10 text-xs tracking-wider outline-none focus:border-cyan-500/50"
                    />
                  </div>
                  {authMode === "SIGNUP" && (
                    <input
                      type="text"
                      placeholder="DISPLAY NAME"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full bg-black/50 border border-white/10 rounded p-3 text-xs tracking-wider outline-none focus:border-cyan-500/50"
                    />
                  )}
                </div>

                {authMode === "LOGIN" ? (
                  <button disabled={isLoading} className="w-full bg-white text-black font-bold py-3 rounded hover:bg-cyan-400 transition-all text-xs tracking-widest flex justify-center">
                    {isLoading ? <Loader2 className="animate-spin" size={16} /> : "INITIALIZE"}
                  </button>
                ) : capturedBlobs.length === 5 ? (
                  <button disabled={isLoading} className="w-full bg-cyan-500 text-black font-bold py-3 rounded hover:bg-cyan-400 transition-all text-xs tracking-widest flex justify-center gap-2">
                    {isLoading ? <Loader2 className="animate-spin" size={16} /> : "CREATE IDENTITY"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsEnrolling(true)}
                    disabled={usernameAvailable === false || !username}
                    className="w-full border border-dashed border-white/20 py-4 rounded text-xs text-white/50 hover:text-cyan-400 hover:border-cyan-500/50 transition-all tracking-widest flex flex-col items-center gap-2"
                  >
                    <ScanFace size={20} /> CALIBRATE BIOMETRICS
                  </button>
                )}
              </form>
            )}
          </div>
        </div>
      )}

      {/* --- SCENE 2: READY --- */}
      {appState === "READY" && user && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur-xl animate-in fade-in duration-700">
          <div className="text-center space-y-6">
            <div className="inline-block p-4 rounded-full border border-cyan-500/20 bg-cyan-500/5 animate-pulse">
              <ScanFace size={48} className="text-cyan-400" />
            </div>
            <div>
              <h1 className="text-4xl font-thin tracking-[0.2em] text-white">IDENTITY VERIFIED</h1>
              <p className="text-white/30 text-xs font-mono mt-2">
                SUBJECT: {user.fullName.toUpperCase()}
              </p>
            </div>
            <button
              onClick={startExperience}
              className="px-10 py-4 bg-white text-black font-bold text-xs tracking-widest rounded hover:bg-cyan-400 hover:scale-105 transition-all"
            >
              ESTABLISH NEURAL LINK
            </button>
          </div>
        </div>
      )}

      {/* --- SCENE 3: LIVE CHAT --- */}
      {appState === "LIVE" && (
        <>
          <div className="absolute top-4 left-0 w-full p-4 flex justify-between items-start z-30 pointer-events-none">
            <div className="flex items-center gap-2 opacity-70">
              <div className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
              <span className="text-[9px] tracking-wider">{isConnected ? "LINK ACTIVE" : "RECONNECTING"}</span>
            </div>
            <span className="text-[9px] opacity-50 font-mono">SESSION: {formatTime(sessionTime)}</span>
          </div>

          <div className="absolute bottom-0 left-0 right-0 p-6 z-40 pointer-events-none">
            <div className="max-w-3xl mx-auto">
              <div className="max-h-80 overflow-y-auto scrollbar-thin scrollbar-thumb-cyan-500/30 scrollbar-track-transparent pr-4 mb-4 space-y-3">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[70%] px-4 py-2 rounded-2xl text-sm backdrop-blur-md ${msg.role === "user" ? "bg-cyan-500/20 border border-cyan-400/30 text-cyan-50" : "bg-purple-500/20 border border-purple-400/30 text-purple-50"} shadow-[0_0_15px_rgba(0,255,255,0.2)]`}>
                      {msg.text}
                      <div className="text-[10px] opacity-50 mt-1 text-right">{new Date(msg.timestamp).toLocaleTimeString()}</div>
                    </div>
                  </div>
                ))}
                {currentResponse && (
                  <div className="flex justify-start">
                    <div className="max-w-[70%] px-4 py-2 rounded-2xl bg-purple-500/20 border border-purple-400/30 text-purple-50 backdrop-blur-md">
                      {currentResponse}
                      <span className="ml-1 inline-block w-2 h-4 bg-purple-400 animate-pulse" />
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              <div className="flex items-center justify-between pointer-events-auto">
                <button
                  onClick={toggleStandby}
                  className={`group flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-xl border transition-all duration-300 ${!isMicActive ? "bg-yellow-500/10 border-yellow-500/30 text-yellow-300" : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10"}`}
                >
                  <Power size={14} />
                  <span className="text-xs font-mono">{!isMicActive ? "STANDBY" : "ACTIVE"}</span>
                </button>

                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${isMicActive ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
                  <span className="text-[9px] opacity-50 font-mono">{isMicActive ? "MIC ON" : "MIC OFF"}</span>
                </div>
              </div>
            </div>
          </div>

          {!isAvatarSpeaking && !currentResponse && messages.length === 0 && (
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-cyan-400 rounded-full opacity-30 animate-pulse" />
          )}
        </>
      )}
    </main>
  );
}
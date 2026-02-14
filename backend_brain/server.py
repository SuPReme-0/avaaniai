import uvicorn
import os
import sys
import json
import base64
import numpy as np
import cv2
import asyncio
import time
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from contextlib import asynccontextmanager
from dotenv import load_dotenv

# 1. Path Setup & Env
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
load_dotenv()

# ==========================================
# GLOBAL AI STATE & LOGS
# ==========================================
# These hold the heavy AI models once loaded
brain = None
vision = None
mouth = None

# This tracks the loading progress for the UI
boot_state = {
    "status": "BOOTING",
    "logs": ["Initializing Kernel...", "Server Port Bound."],
    "modules": {
        "brain": "pending",  # pending, loading, ready, error
        "vision": "pending",
        "mouth": "pending"
    },
    "progress": 5
}

# ==========================================
# BACKGROUND LOADER (The Fix for Render Timeouts)
# ==========================================
async def load_ai_models_background():
    """
    Loads heavy AI models in a non-blocking background task.
    Updates global state so the / (root) UI can show progress.
    """
    global brain, vision, mouth, boot_state
    
    # Wait a sec to let Uvicorn accept the first HTTP request (Health Check)
    await asyncio.sleep(2)
    
    # --- 1. Load BRAIN ---
    try:
        boot_state["modules"]["brain"] = "loading"
        boot_state["logs"].append("🧠 Initializing Brain (Groq LLM)...")
        boot_state["progress"] = 20
        
        from modules.brain import BrainSystem
        brain = BrainSystem()
        
        boot_state["modules"]["brain"] = "ready"
        boot_state["logs"].append("✅ Brain Active.")
    except Exception as e:
        boot_state["modules"]["brain"] = "error"
        boot_state["logs"].append(f"❌ Brain Failed: {str(e)}")
        print(f"Brain Error: {e}")

    # --- 2. Load VISION (The Heavy One) ---
    try:
        boot_state["modules"]["vision"] = "loading"
        boot_state["logs"].append("👁️ Loading Vision (TensorFlow/DeepFace)...")
        boot_state["progress"] = 50
        
        # Yield control briefly so the server stays responsive
        await asyncio.sleep(0.1)
        
        from modules.eyes import VisionSystem
        vision = VisionSystem()
        
        boot_state["modules"]["vision"] = "ready"
        boot_state["logs"].append("✅ Vision Active.")
    except Exception as e:
        boot_state["modules"]["vision"] = "error"
        boot_state["logs"].append(f"❌ Vision Failed: {str(e)}")
        print(f"Vision Error: {e}")

    # --- 3. Load MOUTH ---
    try:
        boot_state["modules"]["mouth"] = "loading"
        boot_state["logs"].append("👄 Loading Mouth (Kokoro TTS)...")
        boot_state["progress"] = 80
        
        await asyncio.sleep(0.1)
        
        from modules.mouth import Mouth
        mouth = Mouth()
        
        boot_state["modules"]["mouth"] = "ready"
        boot_state["logs"].append("✅ Mouth Active.")
    except Exception as e:
        boot_state["modules"]["mouth"] = "error"
        boot_state["logs"].append(f"❌ Mouth Failed: {str(e)}")

    # --- FINALIZATION ---
    boot_state["progress"] = 100
    boot_state["status"] = "ONLINE"
    boot_state["logs"].append("✨ SYSTEM READY. Listening for WebSockets...")

# ==========================================
# LIFESPAN MANAGER
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # This ensures the server starts INSTANTLY
    task = asyncio.create_task(load_ai_models_background())
    yield
    # Cleanup (if needed)

app = FastAPI(title="Avaani AI Core", lifespan=lifespan)

# CORS: Allow Vercel Frontend to connect
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth Routes (Lightweight, so we load them immediately)
from modules.auth import router as auth_router, supabase
app.include_router(auth_router)

# ==========================================
# 🖥️ VISUAL BOOT DASHBOARD (The Root Route)
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def status_dashboard():
    """
    Returns a High-Tech HTML Dashboard showing live boot progress.
    Auto-refreshes every 2 seconds until loaded.
    """
    
    # Status Colors
    colors = {
        "pending": "#555",
        "loading": "#facc15", # Yellow
        "ready": "#22d3ee",   # Cyan
        "error": "#f43f5e"    # Red
    }
    
    # Generate Module Badges
    modules_html = ""
    for name, status in boot_state["modules"].items():
        color = colors.get(status, "#555")
        icon = "⏳" if status == "pending" else "🔄" if status == "loading" else "✅" if status == "ready" else "❌"
        animation = "animation: blink 1s infinite;" if status == "loading" else ""
        
        modules_html += f"""
        <div style="border: 1px solid {color}; padding: 15px; border-radius: 8px; flex: 1; text-align: center; margin: 0 5px; color: {color}; {animation}">
            <div style="font-size: 20px; margin-bottom: 5px;">{icon}</div>
            <div style="text-transform: uppercase; font-size: 12px; font-weight: bold;">{name}</div>
            <div style="font-size: 10px; opacity: 0.8;">{status}</div>
        </div>
        """

    # Generate Logs
    logs_html = "".join([f"<div style='margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; color: #aaa;'>&gt; {log}</div>" for log in boot_state["logs"]])

    # Refresh Logic: Stop refreshing if online to save bandwidth
    refresh_tag = '<meta http-equiv="refresh" content="2">' if boot_state["status"] != "ONLINE" else ""

    return f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Avaani Core | {boot_state['status']}</title>
        {refresh_tag}
        <style>
            body {{ background: #050505; color: #e0e0e0; font-family: 'Courier New', monospace; margin: 0; display: flex; align-items: center; justify-content: center; height: 100vh; }}
            .console {{ width: 90%; max-width: 700px; border: 1px solid #333; background: #0a0a0a; border-radius: 10px; box-shadow: 0 0 40px rgba(0,0,0,0.8); overflow: hidden; }}
            .header {{ background: #111; padding: 15px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }}
            .status-badge {{ background: {colors.get('ready') if boot_state['status'] == 'ONLINE' else colors.get('loading')}; color: #000; padding: 5px 10px; border-radius: 4px; font-weight: bold; font-size: 12px; }}
            .modules-grid {{ display: flex; padding: 20px; border-bottom: 1px solid #333; }}
            .logs-window {{ background: #000; padding: 20px; height: 300px; overflow-y: auto; font-size: 12px; font-family: 'Consolas', monospace; }}
            .progress-bar {{ height: 4px; background: #222; width: 100%; }}
            .fill {{ height: 100%; background: #22d3ee; width: {boot_state['progress']}%; transition: width 0.5s ease; }}
            @keyframes blink {{ 50% {{ opacity: 0.5; }} }}
        </style>
    </head>
    <body>
        <div class="console">
            <div class="header">
                <div>AVAANI AI KERNEL <span style="font-size: 10px; opacity: 0.5;">v1.0.4 PROD</span></div>
                <div class="status-badge">{boot_state['status']}</div>
            </div>
            <div class="progress-bar"><div class="fill"></div></div>
            <div class="modules-grid">
                {modules_html}
            </div>
            <div class="logs-window" id="logs">
                {logs_html}
            </div>
        </div>
        <script>
            var objDiv = document.getElementById("logs");
            objDiv.scrollTop = objDiv.scrollHeight;
        </script>
    </body>
    </html>
    """

# ==========================================
# 🔌 WEBSOCKET ENDPOINT
# ==========================================
@app.websocket("/ws/avaani")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # Initialize Ears (Lightweight)
    from modules.ears import EarSystem
    ears = EarSystem()

    try:
        while True:
            data = await websocket.receive_json()
            
            # 1. Reject packets if AI is still loading
            if boot_state["status"] != "ONLINE":
                await websocket.send_json({"type": "status", "mode": "system_loading", "progress": boot_state["progress"]})
                continue
                
            packet_type = data.get("type")
            payload = data.get("payload")

            # 2. Handle Video (Vision)
            if packet_type == "video" and payload and vision:
                try:
                    img_bytes = base64.b64decode(payload)
                    nparr = np.frombuffer(img_bytes, np.uint8)
                    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    if frame is not None: vision.process_frame(frame)
                except: pass

            # 3. Handle Audio (Conversation)
            elif packet_type == "audio" and payload and mouth and brain:
                try:
                    # Decoding
                    audio_bytes = base64.b64decode(payload)
                    audio_chunk = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                    
                    # STT (Hearing)
                    user_text = ears.process_chunk(audio_chunk)
                    
                    if user_text:
                        await websocket.send_json({"type": "status", "mode": "thinking"})
                        
                        # Get Vision Context
                        vision_context = vision.get_context_json()
                        current_emotion = vision_context.get("emotion", "neutral")
                        
                        # LLM (Thinking)
                        response_text = await asyncio.to_thread(brain.think, user_text, vision_context)
                        
                        # Send Text Response first
                        await websocket.send_json({
                            "type": "response_start", 
                            "text": response_text, 
                            "emotion": current_emotion
                        })
                        
                        # Stream Audio (TTS)
                        async for pcm_chunk, sample_rate in mouth.generate_stream(response_text):
                            b64_audio = base64.b64encode(pcm_chunk).decode('utf-8')
                            # Update emotion in real-time as user moves
                            live_emotion = vision.context.get("emotion", "neutral")
                            
                            await websocket.send_json({
                                "type": "audio_chunk", 
                                "payload": b64_audio,
                                "sample_rate": sample_rate, 
                                "emotion": live_emotion 
                            })
                            
                        await websocket.send_json({"type": "response_end"})

                except Exception as e:
                    print(f"Pipeline Error: {e}")

    except WebSocketDisconnect:
        print("Client Disconnected")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    # IMPORTANT: lifespan="on" allows the background loader to run!
    uvicorn.run(app, host="0.0.0.0", port=port, lifespan="on")
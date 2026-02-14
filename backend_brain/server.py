import uvicorn
import os
import sys
import json
import base64
import numpy as np
import cv2
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from contextlib import asynccontextmanager
from dotenv import load_dotenv

# 1. Path Setup
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
load_dotenv()

# Global AI instances
brain = None
vision = None
mouth = None
boot_logs = ["Initializing kernel..."]

# ==========================================
# LIFESPAN MANAGER (Background Loading)
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global brain, vision, mouth, boot_logs
    boot_logs.append("📡 Port bound. Server is online.")
    
    # Lazy import to prevent blocking the port
    from modules.brain import BrainSystem
    from modules.eyes import VisionSystem
    from modules.mouth import Mouth
    
    try:
        boot_logs.append("🧠 Loading Brain (Groq)...")
        brain = BrainSystem()
        
        boot_logs.append("👁️ Loading Vision (YOLO/DeepFace)...")
        vision = VisionSystem()
        
        boot_logs.append("🎙️ Loading Mouth (Kokoro)...")
        mouth = Mouth()
        
        boot_logs.append("✅ ALL SYSTEMS OPERATIONAL.")
    except Exception as e:
        boot_logs.append(f"❌ BOOT ERROR: {str(e)}")
        print(f"Boot Error: {e}")
    yield

app = FastAPI(title="Avaani Core", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Late import of auth
from modules.auth import router as auth_router, supabase
app.include_router(auth_router)

# ==========================================
# SYSTEM BOOT UI (HTML)
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def system_status():
    status_color = "#22d3ee" if vision else "#f43f5e"
    logs_html = "".join([f"<p>> {log}</p>" for log in boot_logs])
    
    return f"""
    <html>
        <head>
            <title>Avaani Core Status</title>
            <style>
                body {{ background: #0a0a0a; color: white; font-family: 'Courier New', monospace; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }}
                .terminal {{ width: 80%; max-width: 600px; background: #111; border: 1px solid {status_color}; padding: 20px; border-radius: 10px; box-shadow: 0 0 20px {status_color}44; }}
                h1 {{ color: {status_color}; font-size: 1.2rem; margin-top: 0; }}
                .logs {{ font-size: 0.9rem; color: #888; height: 200px; overflow-y: auto; }}
                .status {{ display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }}
                .dot {{ width: 10px; height: 10px; background: {status_color}; border-radius: 50%; animation: pulse 1.5s infinite; }}
                @keyframes pulse {{ 0% {{ opacity: 0.4; }} 50% {{ opacity: 1; }} 100% {{ opacity: 0.4; }} }}
            </style>
            <meta http-equiv="refresh" content="5">
        </head>
        <body>
            <div class="terminal">
                <div class="status">
                    <div class="dot"></div>
                    <h1>AVAANI SYSTEM STATUS: {"OPERATIONAL" if vision else "BOOTING"}</h1>
                </div>
                <div class="logs">
                    {logs_html}
                </div>
                <p style="font-size: 0.7rem; color: #444; margin-top: 20px;">Render Port: {os.environ.get("PORT", "10000")} | Python 3.11</p>
            </div>
        </body>
    </html>
    """

# ==========================================
# WEBSOCKET CONTROLLER
# ==========================================
@app.websocket("/ws/avaani")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    from modules.ears import EarSystem
    ears = EarSystem()
    
    try:
        while True:
            data = await websocket.receive_json()
            if vision is None:
                await websocket.send_json({"type": "status", "mode": "system_loading"})
                continue

            packet_type = data.get("type")
            payload = data.get("payload")

            if packet_type == "video" and payload:
                img_bytes = base64.b64decode(payload)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is not None: vision.process_frame(frame)

            elif packet_type == "audio" and payload:
                audio_bytes = base64.b64decode(payload)
                audio_chunk = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                user_text = ears.process_chunk(audio_chunk)
                
                if user_text:
                    await websocket.send_json({"type": "status", "mode": "thinking"})
                    vision_context = vision.get_context_json()
                    response_text = await asyncio.to_thread(brain.think, user_text, vision_context)
                    
                    await websocket.send_json({
                        "type": "response_start", "text": response_text,
                        "emotion": vision_context.get("emotion", "neutral")
                    })
                    
                    async for pcm_chunk, sample_rate in mouth.generate_stream(response_text):
                        b64_audio = base64.b64encode(pcm_chunk).decode('utf-8')
                        await websocket.send_json({
                            "type": "audio_chunk", "payload": b64_audio,
                            "sample_rate": sample_rate, "emotion": vision.context.get("emotion", "neutral")
                        })
                    await websocket.send_json({"type": "response_end"})

    except WebSocketDisconnect: pass
    except Exception as e: print(f"WS Error: {e}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    uvicorn.run(app, host="0.0.0.0", port=port)
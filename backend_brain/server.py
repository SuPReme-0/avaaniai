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
from contextlib import asynccontextmanager
from dotenv import load_dotenv

# 1. Path Setup
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Load environment variables
load_dotenv()

# Global AI instances (Initialized as None for lazy loading)
brain = None
vision = None
mouth = None

# ==========================================
# LIFESPAN MANAGER (The Fix for Render Timeouts)
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    This logic runs in the background. It allows the server to bind 
    to the port immediately so Render doesn't kill the deployment.
    """
    global brain, vision, mouth
    print("🤖 Booting AI Core Systems in background...")
    
    # Import inside lifespan to prevent slow startup blocking port binding
    from modules.brain import BrainSystem
    from modules.eyes import VisionSystem
    from modules.mouth import Mouth
    
    try:
        brain = BrainSystem()
        vision = VisionSystem()
        mouth = Mouth(voice="af_sarah", speed=1.0)
        print("✅ AI Systems initialized and ready.")
    except Exception as e:
        print(f"❌ Failed to initialize AI modules: {e}")
        
    yield
    # Shutdown logic (optional)
    if vision:
        vision.stop()

# ==========================================
# APP INITIALIZATION
# ==========================================
app = FastAPI(title="Avaani Real-Time Core", lifespan=lifespan)

# CORS (Crucial for Vercel/Frontend communication)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Late import of auth router to ensure lifespan starts first
from modules.auth import router as auth_router, supabase
app.include_router(auth_router)

# ==========================================
# WEBSOCKET CONTROLLER
# ==========================================
@app.websocket("/ws/avaani")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔌 Client Connected")
    
    # Local import to prevent collision
    from modules.ears import EarSystem
    ears = EarSystem()
    
    try:
        while True:
            data = await websocket.receive_json()
            packet_type = data.get("type")
            payload = data.get("payload")

            # Check if systems are still loading
            if vision is None or brain is None:
                await websocket.send_json({"type": "status", "mode": "system_loading"})
                continue

            # A. CONFIGURATION / LOGIN
            if packet_type == "config":
                user_id = data.get("user_id")
                username = data.get("username")
                if user_id and username:
                    print(f"👤 Loading Biometrics for: {username}")
                    await asyncio.to_thread(vision.load_user_into_memory, supabase, user_id, username)
                    await websocket.send_json({"type": "system", "status": "biometrics_loaded"})

            # B. VIDEO STREAM (Eyes)
            elif packet_type == "video" and payload:
                try:
                    img_bytes = base64.b64decode(payload)
                    nparr = np.frombuffer(img_bytes, np.uint8)
                    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    if frame is not None:
                        vision.process_frame(frame)
                except: pass

            # C. AUDIO STREAM (Ears)
            elif packet_type == "audio" and payload:
                try:
                    audio_bytes = base64.b64decode(payload)
                    audio_chunk = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                    user_text = ears.process_chunk(audio_chunk)
                    
                    if user_text:
                        print(f"🗣️ User: {user_text}")
                        await websocket.send_json({"type": "status", "mode": "thinking"})
                        
                        vision_context = vision.get_context_json()
                        response_text = await asyncio.to_thread(brain.think, user_text, vision_context)
                        
                        current_emotion = vision_context.get("emotion", "neutral")
                        await websocket.send_json({
                            "type": "response_start",
                            "text": response_text,
                            "emotion": current_emotion
                        })
                        
                        async for pcm_chunk, sample_rate in mouth.generate_stream(response_text):
                            b64_audio = base64.b64encode(pcm_chunk).decode('utf-8')
                            live_emotion = vision.context.get("emotion", "neutral")
                            
                            await websocket.send_json({
                                "type": "audio_chunk",
                                "payload": b64_audio,
                                "sample_rate": sample_rate,
                                "emotion": live_emotion 
                            })
                            
                        await websocket.send_json({"type": "response_end"})
                        
                except Exception as e:
                    print(f"❌ Audio Pipeline Error: {e}")

    except WebSocketDisconnect:
        print("❌ Client Disconnected")
    except Exception as e:
        print(f"⚠️ Server Error: {e}")

# ==========================================
# HEALTH CHECK
# ==========================================
@app.get("/")
def health_check():
    return {
        "status": "online", 
        "loading_complete": vision is not None,
        "port": os.environ.get("PORT", 8000)
    }

if __name__ == "__main__":
    # REQUIRED FOR RENDER: Bind to the dynamic $PORT environment variable
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port, log_level="info")
import uvicorn
import os
import sys
import json
import base64
import numpy as np
import asyncio
import time
import signal
import traceback
import psutil
from typing import Dict, Any, Optional
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from contextlib import asynccontextmanager
from dotenv import load_dotenv

try:
    import cv2
except ImportError:
    cv2 = None

# ==========================================
# 1. SETUP & CONFIGURATION
# ==========================================
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
load_dotenv()

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
MAX_CLIENTS = int(os.getenv("MAX_CLIENTS", "50"))
HEARTBEAT_INTERVAL = 20  
CONNECTION_TIMEOUT = 60  

CPU_CORES = max(2, os.cpu_count() or 4)
CPU_POOL = ThreadPoolExecutor(max_workers=min(6, CPU_CORES), thread_name_prefix="cpu_worker")
IO_POOL = ThreadPoolExecutor(max_workers=10, thread_name_prefix="io_worker")
AUDIO_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="audio_worker")

active_clients: Dict[str, Dict[str, Any]] = {}
tts_interrupt_flags: Dict[str, asyncio.Event] = {}
system_logs = deque(maxlen=200)
shutdown_event = asyncio.Event()

brain, vision, mouth, ears_module = None, None, None, None

# ==========================================
# 2. LOGGING & UTILS
# ==========================================
def log(module: str, message: str, level: str = "INFO"):
    timestamp = time.strftime("%H:%M:%S")
    icon = "ℹ️" if level == "INFO" else "⚠️" if level == "WARN" else "❌"
    entry = f"[{timestamp}] {icon} [{module}] {message}"
    print(entry)
    system_logs.append(entry)

async def safe_send(websocket: WebSocket, message: dict):
    try:
        await asyncio.wait_for(websocket.send_json(message), timeout=0.5)
    except (asyncio.TimeoutError, WebSocketDisconnect):
        pass
    except Exception as e:
        log("NET", f"Send Error: {e}", "WARN")

# ==========================================
# 3. LIFESPAN (Startup/Shutdown)
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global brain, vision, mouth, ears_module
    
    log("CORE", "🚀 Booting Avaani Server...")
    start_time = time.time()

    try:
        from modules import ears as ears_mod
        from modules.eyes import VisionSystem
        from modules.brain import BrainSystem
        from modules.mouth import Mouth
        
        ears_module = ears_mod
        
        log("CORE", "Initializing AI Subsystems...")
        vision = VisionSystem()
        brain = BrainSystem()
        ears_module.init_models()
        mouth = Mouth()

        if getattr(mouth, 'kokoro', None):
            log("MOUTH", "🔥 Warming up TTS Engine...")
            try:
                async for _ in mouth.generate_stream("System ready."):
                    pass
                log("MOUTH", "✅ TTS Warmup Complete")
            except Exception as e:
                log("MOUTH", f"⚠️ TTS Warmup Warning: {e}", "WARN")

        log("CORE", f"✅ ALL SYSTEMS OPERATIONAL in {time.time() - start_time:.2f}s")
        yield

    except Exception as e:
        log("CORE", f"❌ FATAL BOOT ERROR: {e}", "ERROR")
        traceback.print_exc()
        yield 

    finally:
        log("CORE", "🛑 Shutting down...")
        shutdown_event.set()
        for cid, client in active_clients.items():
            try:
                await client["websocket"].close(code=1001)
            except: pass
            
        if vision and hasattr(vision, 'stop'): vision.stop()
        CPU_POOL.shutdown(wait=False)
        IO_POOL.shutdown(wait=False)
        AUDIO_POOL.shutdown(wait=False)

app = FastAPI(lifespan=lifespan, title="Avaani Core")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

try:
    from modules.auth import router as auth_router, supabase
    app.include_router(auth_router)
except ImportError:
    log("AUTH", "⚠️ Auth module missing", "WARN")

# ==========================================
# 5. CORE LOGIC: CONVERSATION FLOW
# ==========================================
async def handle_conversation(websocket: WebSocket, client_id: str, user_text: str, vision_context: dict):
    if not user_text.strip(): return
    client = active_clients.get(client_id)
    if not client: return
    
    if client_id in tts_interrupt_flags:
        tts_interrupt_flags[client_id].set()
    
    interrupt_flag = asyncio.Event()
    tts_interrupt_flags[client_id] = interrupt_flag

    try:
        await safe_send(websocket, {"type": "status", "mode": "thinking"})
        response_text = await brain.think(user_text, vision_context)
        log("BRAIN", f"User: {user_text[:30]}... -> AI: {response_text[:30]}...")

        start_emotion = vision_context.get("emotion", "neutral")
        await safe_send(websocket, {
            "type": "response_start", "text": response_text, "emotion": start_emotion, "user_name": client.get("full_name", "User")
        })

        if mouth:
            async for pcm, sample_rate in mouth.generate_stream(response_text):
                if interrupt_flag.is_set():
                    log("MOUTH", f"🛑 Speech interrupted for {client_id[:8]}")
                    break
                if shutdown_event.is_set() or client_id not in active_clients:
                    break

                b64_audio = base64.b64encode(pcm).decode('utf-8')
                current_emotion = vision.context.get("emotion", "neutral") if vision else "neutral"
                current_scores = vision.context.get("emotion_probs", {}) if vision else {}

                await safe_send(websocket, {
                    "type": "audio_chunk", "payload": b64_audio, "sample_rate": sample_rate,
                    "emotion": current_emotion, "emotion_scores": current_scores 
                })
                
                await asyncio.sleep(0.001)
                
    except Exception as e:
        log("ERR", f"Conversation Error: {e}", "ERROR")
    finally:
        # ⚡ FIX: Ensure 'response_end' always fires to clean up UI chat bubbles
        await safe_send(websocket, {"type": "response_end", "emotion": start_emotion})
        await safe_send(websocket, {"type": "status", "mode": "listening"})
        if client_id in tts_interrupt_flags and tts_interrupt_flags[client_id] == interrupt_flag:
            del tts_interrupt_flags[client_id]

# ==========================================
# 6. AUTHENTICATION HELPER
# ==========================================
async def verify_token_and_get_user(token: str) -> Optional[str]:
    if not token: return None
    try:
        user = await asyncio.get_running_loop().run_in_executor(IO_POOL, lambda: supabase.auth.get_user(token))
        return user.user.id if user and user.user else None
    except: return None

async def fetch_user_profile(user_id: str) -> str:
    try:
        for table in ["profiles", "users", "user_profiles"]:
            res = await asyncio.get_running_loop().run_in_executor(IO_POOL, lambda t=table: supabase.table(t).select("full_name, username").eq("id", user_id).execute())
            if res.data:
                u = res.data[0]
                return u.get("full_name") or u.get("username") or "User"
    except: pass
    return "User"

# ==========================================
# 7. WEBSOCKET CONTROLLER
# ==========================================
@app.websocket("/ws/avaani")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_id = str(id(websocket))
    
    if len(active_clients) >= MAX_CLIENTS:
        await websocket.close(code=1013, reason="Server at capacity")
        return

    client_state = {
        "websocket": websocket, "id": client_id, "last_heartbeat": time.time(),
        "authenticated": False, "user_id": None, "full_name": "Guest", "audio_buffer": bytearray()  
    }
    
    active_clients[client_id] = client_state
    log("NET", f"🔌 Client Connected: {client_id[:8]}")
    ear_session = ears_module.EarSession() if ears_module else None

    async def heartbeat_monitor():
        while client_id in active_clients and not shutdown_event.is_set():
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if time.time() - client_state["last_heartbeat"] > CONNECTION_TIMEOUT:
                log("NET", f"💔 Client {client_id[:8]} timed out.")
                await websocket.close(code=1000)
                break
            await safe_send(websocket, {"type": "ping"})

    heartbeat_task = asyncio.create_task(heartbeat_monitor())

    try:
        while not shutdown_event.is_set():
            data = await websocket.receive_json()
            client_state["last_heartbeat"] = time.time()
            packet_type = data.get("type")
            payload = data.get("payload")

            if packet_type == "config":
                token = data.get("token") or data.get("access_token")
                user_id = await verify_token_and_get_user(token)
                
                if user_id:
                    client_state.update({"authenticated": True, "user_id": user_id})
                    full_name = await fetch_user_profile(user_id)
                    client_state["full_name"] = full_name
                    
                    if brain: asyncio.create_task(asyncio.to_thread(brain.load_memory, user_id))
                    if vision: asyncio.create_task(asyncio.to_thread(vision.load_user_into_memory, supabase, user_id, data.get("username", "User")))

                    log("AUTH", f"✅ Authenticated: {full_name}")
                    await safe_send(websocket, {"type": "system", "status": "ready", "user_name": full_name})
                else:
                    await safe_send(websocket, {"type": "error", "message": "Auth Failed"})

            elif packet_type == "video" and payload and cv2:
                loop = asyncio.get_running_loop()
                def process_frame_task(b64_data):
                    try:
                        nparr = np.frombuffer(base64.b64decode(b64_data), np.uint8)
                        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                        if frame is not None and vision: 
                            vision.process_frame(frame)
                            ctx = vision.get_context_json()
                            asyncio.run_coroutine_threadsafe(
                                safe_send(websocket, {"type": "eyes_internal", "data": ctx}), loop
                            )
                    except Exception as e: 
                        log("VISION", f"Frame task error: {e}", "WARN")
                CPU_POOL.submit(process_frame_task, payload)

            elif packet_type == "audio" and payload:
                if not ears_module: continue

                try:
                    audio_raw = base64.b64decode(payload)
                    client_state["audio_buffer"].extend(audio_raw)
                    CHUNK_BYTES = 1024 
                    
                    while len(client_state["audio_buffer"]) >= CHUNK_BYTES:
                        chunk_bytes = bytes(client_state["audio_buffer"][:CHUNK_BYTES])
                        del client_state["audio_buffer"][:CHUNK_BYTES]
                        chunk = np.frombuffer(chunk_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                        
                        # 1. ⚡ FAST VAD ONLY (Returns raw audio buffer, does NOT run Whisper)
                        utterance_audio = await asyncio.get_running_loop().run_in_executor(
                            CPU_POOL, ear_session.process_chunk, chunk
                        )

                        # 2. 🛑 TRUE REAL-TIME BARGE-IN: Instantly trigger flag if user speaks
                        if ear_session.get_status() == "receiving_speech":
                            if client_id in tts_interrupt_flags and not tts_interrupt_flags[client_id].is_set():
                                log("EARS", f"🛑 User interrupted! Stopping TTS...")
                                tts_interrupt_flags[client_id].set()

                        # 3. 📝 ASYNC WHISPER (Fire and Forget - Never blocks the loop!)
                        if utterance_audio is not None:
                            ctx = vision.get_context_json() if vision else {}
                            
                            async def async_transcribe_and_reply(data, context):
                                transcript = await asyncio.get_running_loop().run_in_executor(
                                    AUDIO_POOL, ear_session.transcribe, data
                                )
                                if transcript:
                                    log("EARS", f"Heard: {transcript}")
                                    # Forward user's text to frontend UI
                                    await safe_send(websocket, {"type": "user_transcript", "text": transcript})
                                    # Trigger conversation response
                                    await handle_conversation(websocket, client_id, transcript, context)
                            
                            asyncio.create_task(async_transcribe_and_reply(utterance_audio, ctx))

                except Exception as e:
                    log("EARS", f"Processing Error: {e}", "WARN")

            elif packet_type == "ping":
                await safe_send(websocket, {"type": "pong"})
            elif packet_type == "pong":
                pass 

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log("NET", f"WS Error {client_id[:8]}: {e}", "ERROR")
    finally:
        heartbeat_task.cancel()
        if client_id in active_clients: del active_clients[client_id]
        if client_id in tts_interrupt_flags: del tts_interrupt_flags[client_id]
        log("NET", f"🔌 Client Disconnected: {client_id[:8]}")

# ==========================================
# 8. ADMIN DASHBOARD
# ==========================================
@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return f"""
    <!DOCTYPE html><html><head><title>Avaani Core Status</title><meta http-equiv="refresh" content="3">
    <style>body {{ background: #1a1a2e; color: #fff; font-family: monospace; padding: 20px; }}
    .card {{ background: #16213e; padding: 20px; margin-bottom: 20px; border-radius: 8px; border-left: 5px solid #0f3460; }}
    .log-box {{ background: #000; padding: 10px; height: 400px; overflow-y: scroll; border: 1px solid #333; }}
    </style></head><body><h1>🟢 AVAANI SERVER STATUS</h1>
    <div class="card"><h3>Active Connections: {len(active_clients)} / {MAX_CLIENTS}</h3>
    <p>CPU: {psutil.cpu_percent()}% | RAM: {psutil.virtual_memory().percent}%</p></div>
    <div class="log-box">{'<br>'.join(list(system_logs)[-50:])}</div></body></html>
    """

if __name__ == "__main__":
    os.makedirs("logs", exist_ok=True)
    signal.signal(signal.SIGINT, lambda s, f: shutdown_event.set())
    signal.signal(signal.SIGTERM, lambda s, f: shutdown_event.set())

    log("BOOT", f"🚀 Starting Server on {HOST}:{PORT}")
    uvicorn.run("server:app", host=HOST, port=PORT, log_level="warning", reload=False)
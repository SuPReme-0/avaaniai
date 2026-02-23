import os
# ⚡ CRITICAL BUG FIX: These MUST be set before ANY other imports!
# If numpy/torch load before this, they ignore it and thrash all 24 of your threads.
os.environ["OMP_NUM_THREADS"] = "4"
os.environ["MKL_NUM_THREADS"] = "4"
os.environ["OPENBLAS_NUM_THREADS"] = "4"
os.environ["VECLIB_MAXIMUM_THREADS"] = "4"
os.environ["NUMEXPR_NUM_THREADS"] = "4"

import sys
import json
import base64
import uvicorn
import numpy as np
import asyncio
import time
import signal
import traceback
import psutil
import threading
import re
from typing import Dict, Any, Optional
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from contextlib import asynccontextmanager
from dotenv import load_dotenv

try:
    import winloop
    winloop.install()
except ImportError:
    pass

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
BARGE_IN_RMS_THRESHOLD = 0.04

CPU_CORES = psutil.cpu_count(logical=True) or 8

# ⚡ STRICT RESOURCE ISOLATION
IO_POOL = ThreadPoolExecutor(max_workers=32, thread_name_prefix="io_worker")
STT_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt_worker")
TTS_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts_worker")
VAD_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vad_worker")
VISION_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="vision_worker")

active_clients: Dict[str, Dict[str, Any]] = {}
tts_queues: Dict[str, asyncio.Queue] = {}
system_logs = deque(maxlen=200)
shutdown_event = asyncio.Event()

# ⚡ BIOMETRIC RAM CACHE: Prevents redundant face vector loading
vision_loaded_users = set()

brain, vision, mouth, ears_module = None, None, None, None

# ==========================================
# 2. LOGGING & UTILS
# ==========================================
def log(module: str, message: str, level: str = "INFO"):
    timestamp = time.strftime("%H:%M:%S")
    icon = "⏱️" if module == "LATENCY" else "ℹ️" if level == "INFO" else "⚠️" if level == "WARN" else "❌"
    entry = f"[{timestamp}] {icon} [{module}] {message}"
    print(entry)
    system_logs.append(entry)

async def safe_send(websocket: WebSocket, message: dict):
    try:
        await asyncio.wait_for(websocket.send_json(message), timeout=0.5)
    except Exception:
        pass

# ==========================================
# 3. LIFESPAN (Startup/Shutdown)
# ==========================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global brain, vision, mouth, ears_module
    
    log("CORE", "🚀 Booting Avaani Server (Intel CPU Optimized)...")
    start_time = time.time()

    try:
        from modules import ears as ears_mod
        from modules.eyes import VisionSystem
        from modules.brain import BrainSystem
        from modules.mouth import Mouth
        
        ears_module = ears_mod
        vision = VisionSystem()
        brain = BrainSystem()
        ears_module.init_models()
        mouth = Mouth()

        log("CORE", f"✅ ALL SYSTEMS OPERATIONAL in {time.time() - start_time:.2f}s")
        yield

    except Exception as e:
        log("CORE", f"❌ FATAL BOOT ERROR: {e}", "ERROR")
        traceback.print_exc()
        yield 

    finally:
        log("CORE", "🛑 Shutting down...")
        shutdown_event.set()
        
        for q in tts_queues.values():
            await q.put(None)

        for cid, client in active_clients.items():
            try: await client["websocket"].close()
            except: pass
            
        if vision and hasattr(vision, 'stop'): vision.stop()
        for pool in [STT_POOL, TTS_POOL, VAD_POOL, IO_POOL, VISION_POOL]:
            pool.shutdown(wait=False)

app = FastAPI(lifespan=lifespan, title="Avaani Core")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

try:
    from modules.auth import router as auth_router, supabase
    app.include_router(auth_router)
except ImportError:
    pass

# ==========================================
# 4. AUTHENTICATION HELPER
# ==========================================
async def verify_token_and_get_user(token: str) -> Optional[str]:
    if not token: return None
    try:
        user = await asyncio.get_running_loop().run_in_executor(IO_POOL, lambda: supabase.auth.get_user(token))
        return user.user.id if user and user.user else None
    except: return None

async def fetch_user_profile(user_id: str) -> str:
    try:
        res = await asyncio.get_running_loop().run_in_executor(IO_POOL, lambda: supabase.table("profiles").select("full_name, username").eq("id", user_id).execute())
        if res.data:
            return res.data[0].get("full_name") or res.data[0].get("username") or "User"
    except: pass
    return "User"

# ==========================================
# 5. WEBSOCKET CONTROLLER
# ==========================================
@app.websocket("/ws/avaani")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    client_id = str(id(websocket))
    
    if len(active_clients) >= MAX_CLIENTS:
        await websocket.close(code=1013, reason="Server at capacity")
        return

    # ⚡ THREAD-SAFE STATE
    client_state = {
        "websocket": websocket, "id": client_id, "last_heartbeat": time.time(),
        "authenticated": False, "user_id": None, "full_name": "Guest", 
        "audio_buffer": bytearray(), 
        "interrupt_event": threading.Event(), # Matches mouth.py exactly
        "tts_active": False,
        "current_pipeline_task": None,
        "tasks": set()
    }
    
    active_clients[client_id] = client_state
    ear_session = ears_module.EarSession() if ears_module else None
    tts_queues[client_id] = asyncio.Queue()
    
    log("NET", f"🔌 Client Connected: {client_id[:8]}")

    # ==========================================
    # WORKER 1: TTS QUEUE CONSUMER
    # ==========================================
    async def tts_worker_loop():
        queue = tts_queues[client_id]
        
        while not shutdown_event.is_set():
            data = await queue.get()
            if data is None: break 
            
            if client_state["interrupt_event"].is_set():
                queue.task_done()
                continue
                
            try:
                response_text = data["text"]
                start_emotion = data["emotion"]
                t_pipeline_start = data["t_pipeline_start"]

                await safe_send(websocket, {
                    "type": "response_start", "text": response_text, "emotion": start_emotion, "user_name": client_state["full_name"]
                })

                if mouth:
                    client_state["tts_active"] = True
                    if ear_session: ear_session.set_tts_state(True)
                    
                    tts_start_time = time.time()
                    first_byte_emitted = False

                    # Pass threading.Event to cleanly abort generation on barge-in
                    async for pcm, sample_rate in mouth.generate_stream(response_text, client_state["interrupt_event"]):
                        if shutdown_event.is_set() or client_state["interrupt_event"].is_set():
                            break

                        if not first_byte_emitted:
                            first_byte_emitted = True
                            tts_latency = time.time() - tts_start_time
                            total_latency = time.time() - t_pipeline_start
                            log("LATENCY", f"TTS Compute: {tts_latency:.2f}s | TOTAL SYSTEM LATENCY: {total_latency:.2f}s")

                        b64_audio = base64.b64encode(pcm).decode('utf-8')
                        current_emotion = vision.context.get("emotion", "neutral") if vision else "neutral"
                        current_scores = vision.context.get("emotion_probs", {}) if vision else {}
                        
                        await safe_send(websocket, {
                            "type": "audio_chunk", "payload": b64_audio, "sample_rate": sample_rate,
                            "emotion": current_emotion, "emotion_scores": current_scores 
                        })
                        await asyncio.sleep(0)
                        
            except Exception as e:
                log("MOUTH", f"Queue Worker Error: {e}", "ERROR")
            finally:
                client_state["tts_active"] = False
                if ear_session: ear_session.set_tts_state(False)

                if not client_state["interrupt_event"].is_set():
                    await safe_send(websocket, {"type": "response_end", "emotion": data.get("emotion", "neutral")})
                    if queue.empty():
                        await safe_send(websocket, {"type": "status", "mode": "listening"})
                queue.task_done()

    # ==========================================
    # WORKER 2: THE AI PIPELINE (STT -> LLM)
    # ==========================================
    async def run_conversational_pipeline(audio_data: np.ndarray, context: dict):
        try:
            t_pipeline_start = time.time()
            
            # 1. ASYNC STT 
            transcript = await asyncio.get_running_loop().run_in_executor(STT_POOL, ear_session.transcribe, audio_data)
            t_stt_end = time.time()
            
            if not transcript or client_state["interrupt_event"].is_set(): return
            
            log("EARS", f"Heard: {transcript}")
            log("LATENCY", f"STT Time: {t_stt_end - t_pipeline_start:.2f}s")
            
            await safe_send(websocket, {"type": "user_transcript", "text": transcript})
            await safe_send(websocket, {"type": "status", "mode": "thinking"})
            
            # 2. LLM STREAMING
            current_sentence = ""
            first_token_time = None
            
            async for token in brain.stream_think(transcript, context, is_interruption=client_state["interrupt_event"].is_set()):
                if client_state["interrupt_event"].is_set(): break
                
                if first_token_time is None:
                    first_token_time = time.time()
                    log("LATENCY", f"LLM First Token: {first_token_time - t_stt_end:.2f}s")
                    
                current_sentence += token
                
                # CHUNK BY SENTENCE (Passes cleanly to Kokoro)
                if re.search(r'[.!?]\s*$', current_sentence):
                    sentence_to_speak = current_sentence.strip()
                    current_sentence = "" 
                    
                    if sentence_to_speak:
                        log("BRAIN", f"Yielding: {sentence_to_speak}")
                        await tts_queues[client_id].put({
                            "text": sentence_to_speak,
                            "emotion": context.get("emotion", "neutral"),
                            "user_name": client_state["full_name"],
                            "t_pipeline_start": t_pipeline_start
                        })

            # Catch leftovers
            if current_sentence.strip() and not client_state["interrupt_event"].is_set():
                await tts_queues[client_id].put({
                    "text": current_sentence.strip(),
                    "emotion": context.get("emotion", "neutral"),
                    "user_name": client_state["full_name"],
                    "t_pipeline_start": t_pipeline_start
                })
                
        except Exception as e:
            log("ERR", f"Pipeline Error: {e}", "ERROR")

    # ==========================================
    # WORKER 3: VAD FAST-LANE
    # ==========================================
    async def process_vad(chunk: np.ndarray):
        loop = asyncio.get_running_loop()
        
        process_chunk = True
        if client_state["tts_active"]:
            rms = np.sqrt(np.mean(chunk**2))
            if rms < BARGE_IN_RMS_THRESHOLD:
                process_chunk = False
                if hasattr(ear_session, 'reset_vad'): ear_session.reset_vad()

        if process_chunk:
            utterance_audio = await loop.run_in_executor(VAD_POOL, ear_session.process_chunk, chunk)

            if getattr(ear_session, 'status', None) == "receiving_speech" and client_state["tts_active"]:
                if not client_state["interrupt_event"].is_set():
                    log("EARS", "🛑 User interrupted! Halting current thoughts...")
                    client_state["interrupt_event"].set()
                    await safe_send(websocket, {"type": "status", "mode": "interrupted"})
                    
                    while not tts_queues[client_id].empty():
                        try: tts_queues[client_id].get_nowait()
                        except: pass

            if utterance_audio is not None:
                client_state["interrupt_event"].clear() 
                
                if client_state["current_pipeline_task"] and not client_state["current_pipeline_task"].done():
                    client_state["current_pipeline_task"].cancel()
                    
                ctx = vision.get_context_json() if vision else {}
                client_state["current_pipeline_task"] = asyncio.create_task(
                    run_conversational_pipeline(utterance_audio, ctx)
                )

    async def heartbeat_monitor():
        while client_id in active_clients and not shutdown_event.is_set():
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            if time.time() - client_state["last_heartbeat"] > CONNECTION_TIMEOUT:
                break
            await safe_send(websocket, {"type": "ping"})

    client_state["tasks"].update([
        asyncio.create_task(tts_worker_loop()),
        asyncio.create_task(heartbeat_monitor())
    ])

    # ==========================================
    # MAIN RECEIVE LOOP
    # ==========================================
    try:
        while not shutdown_event.is_set():
            message = await websocket.receive()
            client_state["last_heartbeat"] = time.time()
            
            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                if not ears_module: continue
                client_state["audio_buffer"].extend(message["bytes"])
                
                while len(client_state["audio_buffer"]) >= 1024:
                    chunk_bytes = bytes(client_state["audio_buffer"][:1024])
                    del client_state["audio_buffer"][:1024]
                    chunk = np.frombuffer(chunk_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                    asyncio.create_task(process_vad(chunk))

            elif "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                    packet_type = data.get("type")
                    payload = data.get("payload")

                    if packet_type == "config":
                        token = data.get("token") or data.get("access_token")
                        user_id = await verify_token_and_get_user(token)
                        
                        if user_id:
                            client_state.update({"authenticated": True, "user_id": user_id})
                            full_name = await fetch_user_profile(user_id)
                            client_state["full_name"] = full_name
                            
                            # ⚡ BIOMETRIC LOAD GUARD
                            if user_id not in vision_loaded_users and user_id.lower() != "guest":
                                log("AUTH", f"Downloading biometrics for new session: {full_name}")
                                loop = asyncio.get_running_loop()
                                if brain: asyncio.create_task(asyncio.to_thread(brain.load_memory, user_id))
                                if vision: asyncio.create_task(asyncio.to_thread(vision.load_user_into_memory, supabase, user_id, full_name))
                                vision_loaded_users.add(user_id)
                            else:
                                log("AUTH", f"Biometrics already in RAM for {full_name}. Skipping download.")

                            log("AUTH", f"✅ Authenticated: {full_name}")
                            await safe_send(websocket, {"type": "system", "status": "ready", "user_name": full_name})
                            
                    elif packet_type == "video" and payload and cv2:
                        loop = asyncio.get_running_loop()
                        def process_frame_task(b64_data):
                            try:
                                nparr = np.frombuffer(base64.b64decode(b64_data), np.uint8)
                                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                                if frame is not None and vision: 
                                    vision.process_frame(frame)
                                    ctx = vision.get_context_json()
                                    asyncio.run_coroutine_threadsafe(safe_send(websocket, {"type": "eyes_internal", "data": ctx}), loop)
                            except: pass
                        VISION_POOL.submit(process_frame_task, payload)

                    elif packet_type == "ping":
                        await safe_send(websocket, {"type": "pong"})

                except json.JSONDecodeError: pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log("NET", f"WS Error {client_id[:8]}: {e}", "ERROR")
    finally:
        client_state["interrupt_event"].set()
        
        for task in client_state["tasks"]:
            task.cancel()
        if client_state["current_pipeline_task"]:
            client_state["current_pipeline_task"].cancel()
            
        if client_id in tts_queues:
            await tts_queues[client_id].put(None)
            del tts_queues[client_id]
            
        if client_id in active_clients: 
            del active_clients[client_id]
            
        try: await websocket.close()
        except: pass
        log("NET", f"🔌 Client Disconnected: {client_id[:8]}")

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return "<h1>🟢 AVAANI SERVER STATUS</h1>"

if __name__ == "__main__":
    os.makedirs("logs", exist_ok=True)
    signal.signal(signal.SIGINT, lambda s, f: shutdown_event.set())
    signal.signal(signal.SIGTERM, lambda s, f: shutdown_event.set())
    log("BOOT", f"🚀 Starting Server on {HOST}:{PORT}")
    uvicorn.run("server:app", host=HOST, port=PORT, log_level="warning", reload=False)
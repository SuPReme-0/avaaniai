import os
import numpy as np
import requests
import asyncio
import threading
from kokoro_onnx import Kokoro

# ==========================================
# CONFIGURATION
# ==========================================
MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../models")
MODEL_PATH = os.path.join(MODEL_DIR, "kokoro-v1.0.int8.onnx")
VOICES_PATH = os.path.join(MODEL_DIR, "voices-v1.0.bin")

SPEED = 1.10
SAMPLE_RATE = 24000

class Mouth:
    def __init__(self, voice="af_bella", speed=SPEED):
        print("👄 Initializing Avaani Mouth (CPU Optimized)...")
        self.voice = voice
        self.speed = speed
        self.kokoro = None
        self._voice_embedding_cache = {}
        self._warmup_done = threading.Event()

        os.makedirs(MODEL_DIR, exist_ok=True)
        # Load in background so the server boots instantly
        threading.Thread(target=self._background_init, daemon=True).start()

    def _background_init(self):
        self._download_if_missing(MODEL_URL, MODEL_PATH, "Kokoro model")
        self._download_if_missing(VOICES_URL, VOICES_PATH, "Voices file")

        try:
            self.kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
            print("✅ Kokoro model loaded")
        except Exception as e:
            print(f"❌ Kokoro load failed: {e}")
            return

        self._precompute_voice_embedding(self.voice)
        self._full_warmup()
        self._warmup_done.set()
        print("🔥 Mouth warmed up and ready")

    @staticmethod
    def _download_if_missing(url, path, name):
        if os.path.exists(path):
            return
        print(f"⬇️ Downloading {name}...")
        r = requests.get(url, timeout=30, stream=True)
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        print(f"✅ {name} ready")

    def _precompute_voice_embedding(self, voice_name):
        if voice_name in self._voice_embedding_cache:
            return
        try:
            embedding = self.kokoro.get_voice_embedding(voice_name)
            self._voice_embedding_cache[voice_name] = embedding
            print(f"✅ Voice embedding cached: {voice_name}")
        except AttributeError:
            # Fallback for older kokoro-onnx versions
            loop = asyncio.new_event_loop()
            async def _cache():
                async for _ in self.kokoro.create_stream("a", voice=voice_name, speed=self.speed, lang="en-us"):
                    break
            loop.run_until_complete(_cache())
            print(f"⚠️ Voice {voice_name} primed (embedding not cached directly)")

    def _full_warmup(self):
        async def _warmup():
            for _ in range(2):
                async for _ in self.kokoro.create_stream("Warmup.", voice=self.voice, speed=self.speed, lang="en-us"):
                    break
        loop = asyncio.new_event_loop()
        loop.run_until_complete(_warmup())
        loop.close()

    async def generate_stream(self, text):
        """
        Yields small, strictly sized PCM chunks optimized for instant I/O loops.
        """
        if not text or self.kokoro is None:
            return

        clean_text = text.replace("Avaani", "Avni").replace("avaani", "avni")
        
        CHUNK_SIZE = 4096 
        out_buffer = bytearray()

        try:
            async for samples, _ in self.kokoro.create_stream(
                clean_text, voice=self.voice, speed=self.speed, lang="en-us"
            ):
                # Convert float32 [-1.0, 1.0] to int16 PCM bytes rapidly
                pcm_bytes = (samples * 32767.0).astype(np.int16).tobytes()
                out_buffer.extend(pcm_bytes)

                # Slice the buffer into strict chunks and yield
                while len(out_buffer) >= CHUNK_SIZE:
                    chunk = bytes(out_buffer[:CHUNK_SIZE])
                    
                    # ⚡ OPTIMIZATION: Reassign slice instead of using 'del' 
                    out_buffer = out_buffer[CHUNK_SIZE:]
                    
                    yield chunk, SAMPLE_RATE
                    
                    # ⚡ OPTIMIZATION: Instant yield to the event loop (0ms block)
                    await asyncio.sleep(0)

            # Flush any remaining audio in the buffer after the model finishes
            if out_buffer:
                yield bytes(out_buffer), SAMPLE_RATE

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"❌ TTS stream error: {e}")

    def update_voice(self, voice_name):
        if voice_name == self.voice:
            return
        self.voice = voice_name
        if self.kokoro:
            threading.Thread(target=self._precompute_voice_embedding, args=(voice_name,), daemon=True).start()
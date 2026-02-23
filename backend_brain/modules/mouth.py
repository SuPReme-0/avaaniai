import os
import re
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
INT16_MAX = 32767.0

# ⚡ HUMANIZATION PADDING
PUNCTUATION_PAUSE_SAMPLES = 4800 # 0.2 seconds
SILENT_PADDING = np.zeros(PUNCTUATION_PAUSE_SAMPLES, dtype=np.int16).tobytes()

# ⚡ PRE-COMPILED REGEX FOR BLAZING FAST TEXT NORMALIZATION
PAUSE_REGEX_COMMA = re.compile(r'[,;:]')
PAUSE_REGEX_STOP = re.compile(r'[.!?'']+(?=\s|$)')

class Mouth:
    def __init__(self, voice="af_bella", speed=SPEED):
        print("👄 Initializing Avaani Mouth (Max CPU Power & Humanized)...")
        self.voice = voice
        self.speed = speed
        self.kokoro = None
        self._voice_embedding_cache = {}
        self._warmup_done = threading.Event()

        os.makedirs(MODEL_DIR, exist_ok=True)
        threading.Thread(target=self._background_init, daemon=True).start()

    def _background_init(self):
        self._download_if_missing(MODEL_URL, MODEL_PATH, "Kokoro model")
        self._download_if_missing(VOICES_URL, VOICES_PATH, "Voices file")

        try:
            self.kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
            print("✅ Kokoro ONNX loaded")
        except Exception as e:
            print(f"❌ Kokoro load failed: {e}")
            return

        self._precompute_voice_embedding(self.voice)
        self._full_warmup()
        self._warmup_done.set()
        print("🔥 Mouth warmed up and ready")

    @staticmethod
    def _download_if_missing(url, path, name):
        if os.path.exists(path): return
        print(f"⬇️ Downloading {name}...")
        try:
            r = requests.get(url, timeout=30, stream=True)
            r.raise_for_status()
            with open(path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            print(f"✅ {name} ready")
        except Exception as e:
            print(f"❌ Failed to download {name}: {e}")

    def _precompute_voice_embedding(self, voice_name):
        if voice_name in self._voice_embedding_cache: return
        try:
            embedding = self.kokoro.get_voice_embedding(voice_name)
            self._voice_embedding_cache[voice_name] = embedding
        except AttributeError:
            loop = asyncio.new_event_loop()
            async def _cache():
                async for _ in self.kokoro.create_stream("a", voice=voice_name, speed=self.speed, lang="en-us"):
                    break
            loop.run_until_complete(_cache())

    def _full_warmup(self):
        loop = asyncio.new_event_loop()
        async def _warmup():
            for _ in range(2):
                async for _ in self.kokoro.create_stream("Warmup.", voice=self.voice, speed=self.speed, lang="en-us"):
                    break
        loop.run_until_complete(_warmup())
        loop.close()

    def warmup(self):
        """Called synchronously by server.py the moment STT starts."""
        if not self._warmup_done.is_set() or self.kokoro is None: return
        try:
            loop = asyncio.new_event_loop()
            async def _micro_heat():
                async for _ in self.kokoro.create_stream("a", voice=self.voice, speed=self.speed, lang="en-us"):
                    break
            loop.run_until_complete(_micro_heat())
            loop.close()
        except Exception:
            pass

    def _optimize_text_for_pauses(self, text: str) -> str:
        text = text.replace("Avaani", "Avni").replace("avaani", "avni")
        text = PAUSE_REGEX_COMMA.sub(" ... ", text)
        text = PAUSE_REGEX_STOP.sub(" .... ", text)
        return text.strip()

    async def generate_stream(self, text: str, interrupt_event: threading.Event):
        if not text or not self._warmup_done.is_set(): return

        clean_text = self._optimize_text_for_pauses(text)
        CHUNK_SIZE = 4096 
        out_buffer = bytearray()
        
        try:
            async for samples, _ in self.kokoro.create_stream(
                clean_text, voice=self.voice, speed=self.speed, lang="en-us"
            ):
                if interrupt_event.is_set():
                    break 

                pcm_bytes = (samples * INT16_MAX).astype(np.int16).tobytes()
                out_buffer.extend(pcm_bytes)

                while len(out_buffer) >= CHUNK_SIZE:
                    chunk = bytes(out_buffer[:CHUNK_SIZE])
                    del out_buffer[:CHUNK_SIZE] 
                    
                    yield chunk, SAMPLE_RATE
                    await asyncio.sleep(0)

            if out_buffer and not interrupt_event.is_set():
                yield bytes(out_buffer), SAMPLE_RATE
                
            if not interrupt_event.is_set():
                yield SILENT_PADDING, SAMPLE_RATE

        except asyncio.CancelledError:
            pass 
        except Exception as e:
            print(f"❌ TTS Error: {e}")

    def update_voice(self, voice_name):
        if voice_name == self.voice: return
        self.voice = voice_name
        if self.kokoro:
            threading.Thread(target=self._precompute_voice_embedding, args=(voice_name,), daemon=True).start()
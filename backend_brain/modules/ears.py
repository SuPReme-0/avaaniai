import torch
import numpy as np
import os
import time
import re
import logging
import multiprocessing
from faster_whisper import WhisperModel
from scipy import signal
from typing import Optional, List

# ==========================================
# CONFIGURATION 
# ==========================================
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR_NAME = "base.en"
MODEL_PATH = os.path.join(CURRENT_DIR, "../../models", MODEL_DIR_NAME)

# ⚡ INTEL CPU OPTIMIZATIONS
DEVICE = "cpu"                    
COMPUTE_TYPE = "int8"               # CRITICAL: Forces 8-bit math for CPU speed
CPU_THREADS = max(4, multiprocessing.cpu_count() - 2) # Use available cores minus 2 for OS stability

# ⚡ DYNAMIC VAD PARAMETERS (Normal vs. TTS Playing)
VAD_THRESHOLD_NORMAL = 0.45                
VAD_THRESHOLD_DUCKING = 0.75        
SILENCE_LIMIT = 0.5                 
MIN_SPEECH_DURATION = 0.3           
RMS_THRESHOLD_NORMAL = 0.005        
RMS_THRESHOLD_DUCKING = 0.020       

# Whisper parameters
BEAM_SIZE = 1                       
LANGUAGE = "en"
INITIAL_PROMPT = "Avaani. Avni. Hello Avni, I am speaking to you."
NO_SPEECH_THRESHOLD = 0.40          
AVG_LOGPROB_THRESHOLD = -0.8        
MAX_CHARS_PER_SECOND = 25            

NAME_PATTERN = re.compile(r'\b(avni|avaani|avani)\b', re.IGNORECASE)

BLACKLIST_EXACT = {
    "thank you", "thanks", "subtitles", "copyright", "audio", "video",
    "watching", "subscribe", "amara.org", "amara", "uh", "um", "ah", "er"
}
AFFIRMATIVES = {"yes", "no", "okay", "ok", "yeah", "yep", "nah", "you"}

MAX_UTTERANCE_SECONDS = 30

# ==========================================
# GLOBAL CACHE (Stateless Models Only)
# ==========================================
_stt_model = None
_sos_filter = None          

def init_models():
    global _stt_model, _sos_filter
    if _stt_model is not None: return

    logging.info(f"👂 Initializing Avaani Ears (Intel CPU Optimized | {CPU_THREADS} Threads)...")
    
    # Restrict PyTorch to prevent CPU thrashing
    torch.set_num_threads(CPU_THREADS)
    torch.set_grad_enabled(False)

    abs_model_path = os.path.abspath(MODEL_PATH)
    local_files = os.path.exists(abs_model_path)
    
    try:
        _stt_model = WhisperModel(
            model_size_or_path=abs_model_path if local_files else MODEL_DIR_NAME,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            cpu_threads=CPU_THREADS, # ⚡ Feed thread count directly to CTranslate2
            local_files_only=local_files
        )
        logging.info(f"✅ Whisper Model Loaded ({MODEL_DIR_NAME}, {DEVICE}, {COMPUTE_TYPE})")
    except Exception as e:
        logging.error(f"❌ Whisper Init Error: {e}")
        raise

    _sos_filter = signal.butter(10, [80, 7500], 'bandpass', fs=16000, output='sos')
    logging.info("✅ DSP Bandpass Filter Ready")

# ==========================================
# PER-SESSION STT ENGINE
# ==========================================
class EarSession:
    def __init__(self):
        init_models() 
        try:
            # ⚡ ONNX backend is the fastest way to run Silero VAD on an Intel CPU
            self.vad_model, _ = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                force_reload=False,
                onnx=True, 
                trust_repo=True
            )
            self.vad_model.reset_states()
        except Exception as e:
            logging.error(f"❌ VAD Load Error: {e}")
            raise

        self.audio_chunks: List[np.ndarray] = []
        self.is_speaking = False
        self.silence_start_time: Optional[float] = None
        self.status = "listening"          
        self.utterance_start_time = None
        self.tts_is_active = False  

    def set_tts_state(self, is_active: bool):
        self.tts_is_active = is_active

    def process_chunk(self, audio_chunk: np.ndarray) -> Optional[np.ndarray]:
        if audio_chunk is None or audio_chunk.size == 0: return None
        if audio_chunk.dtype != np.float32: audio_chunk = audio_chunk.astype(np.float32, copy=False)

        current_rms_thresh = RMS_THRESHOLD_DUCKING if self.tts_is_active else RMS_THRESHOLD_NORMAL
        current_vad_thresh = VAD_THRESHOLD_DUCKING if self.tts_is_active else VAD_THRESHOLD_NORMAL

        rms = np.sqrt(np.mean(np.square(audio_chunk)))
        if rms < current_rms_thresh: 
            audio_chunk = np.zeros_like(audio_chunk, dtype=np.float32)

        try:
            audio_tensor = torch.from_numpy(audio_chunk)
            speech_prob = self.vad_model(audio_tensor, 16000).item()
        except Exception:
            speech_prob = 0.0

        now = time.time()

        if speech_prob > current_vad_thresh:
            if not self.is_speaking:
                self.is_speaking = True
                self.status = "receiving_speech"
                self.utterance_start_time = now
                self.audio_chunks = []

            self.silence_start_time = None
            self.audio_chunks.append(audio_chunk)
        else:
            if self.is_speaking:
                if self.silence_start_time is None:
                    self.silence_start_time = now

                silence_duration = now - self.silence_start_time
                if silence_duration < SILENCE_LIMIT:
                    self.audio_chunks.append(audio_chunk)
                else:
                    return self._flush_utterance()

        if self.is_speaking and (now - self.utterance_start_time) > MAX_UTTERANCE_SECONDS:
            return self._flush_utterance()

        return None

    def _flush_utterance(self) -> Optional[np.ndarray]:
        self.is_speaking = False
        self.status = "processing"
        audio_data = np.concatenate(self.audio_chunks).astype(np.float32) if self.audio_chunks else None
        self.audio_chunks = []
        self.silence_start_time = None
        self.utterance_start_time = None
        self.status = "listening"
        self.vad_model.reset_states() 
        return audio_data

    def transcribe(self, audio_data: np.ndarray) -> Optional[str]:
        if audio_data is None: return None
        duration_sec = len(audio_data) / 16000.0
        if duration_sec < MIN_SPEECH_DURATION: return None

        try:
            audio_data = signal.sosfilt(_sos_filter, audio_data)
            max_peak = np.max(np.abs(audio_data))
            if max_peak > 0.08:
                audio_data = audio_data * (0.92 / max_peak)
        except Exception: pass

        try:
            segments_generator, _ = _stt_model.transcribe(
                audio_data, beam_size=BEAM_SIZE, language=LANGUAGE,
                condition_on_previous_text=False, temperature=0.0, initial_prompt=INITIAL_PROMPT
            )
            segments = list(segments_generator)

            for seg in segments:
                if seg.no_speech_prob > NO_SPEECH_THRESHOLD or seg.avg_logprob < AVG_LOGPROB_THRESHOLD:
                    return None

            text = " ".join(seg.text.strip() for seg in segments).strip()
            if not text or len(text) < 2: return None
            if len(text) > (duration_sec * MAX_CHARS_PER_SECOND): return None
            if NAME_PATTERN.search(text): return text

            cleaned = re.sub(r'[^\w\s]', '', text.lower())
            if cleaned in BLACKLIST_EXACT: return None
            if cleaned in AFFIRMATIVES: return text.capitalize()

            return text
        except Exception as e:
            logging.error(f"[Ears] STT Error: {e}")
            return None

    def get_status(self) -> str:
        return self.status
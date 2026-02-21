import torch
import numpy as np
import os
import time
import re
import logging
from faster_whisper import WhisperModel
from scipy import signal
from typing import Optional, List

# ==========================================
# CONFIGURATION 
# ==========================================
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR_NAME = "base.en"
MODEL_PATH = os.path.join(CURRENT_DIR, "../../models", MODEL_DIR_NAME)

DEVICE = "cpu"                     
COMPUTE_TYPE = "int8"               

# VAD parameters
VAD_THRESHOLD = 0.45                
SILENCE_LIMIT = 0.6                 
MIN_SPEECH_DURATION = 0.3           
MIN_ENERGY_THRESHOLD = 0.015        

# Whisper parameters
BEAM_SIZE = 1                       
LANGUAGE = "en"
INITIAL_PROMPT = "Avaani. Avni. Hello Avni, I am speaking to you."
NO_SPEECH_THRESHOLD = 0.30          
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
    """Load Whisper and DSP filter once. VAD is loaded per-session."""
    global _stt_model, _sos_filter

    if _stt_model is not None:
        return

    logging.info("👂 Initializing Avaani Ears (Hallucination-Proof)...")
    torch.set_num_threads(4)
    torch.set_grad_enabled(False)

    abs_model_path = os.path.abspath(MODEL_PATH)
    local_files = os.path.exists(abs_model_path)
    
    try:
        _stt_model = WhisperModel(
            model_size_or_path=abs_model_path if local_files else MODEL_DIR_NAME,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            cpu_threads=4,
            local_files_only=local_files
        )
        logging.info(f"✅ Whisper Model Loaded ({MODEL_DIR_NAME}, {COMPUTE_TYPE})")
    except Exception as e:
        logging.error(f"❌ Whisper Init Error: {e}")
        raise

    _sos_filter = signal.butter(10, [80, 7500], 'bandpass', fs=16000, output='sos')
    logging.info("✅ DSP Bandpass Filter Ready")

# ==========================================
# PER-SESSION STT ENGINE (Inside ears.py)
# ==========================================
class EarSession:
    def __init__(self):
        init_models() 
        try:
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

    def process_chunk(self, audio_chunk: np.ndarray) -> Optional[np.ndarray]:
        """
        FAST VAD ONLY: Returns the full audio buffer when speech ends.
        Does NOT block for transcription.
        """
        if audio_chunk is None or audio_chunk.size == 0: return None
        if audio_chunk.dtype != np.float32: audio_chunk = audio_chunk.astype(np.float32, copy=False)

        # Lowered threshold to ensure quiet speech is caught
        rms = np.sqrt(np.mean(np.square(audio_chunk)))
        if rms < 0.005: 
            audio_chunk = np.zeros_like(audio_chunk, dtype=np.float32)

        try:
            # Silero expects 1D or (batch, samples), pass safely
            audio_tensor = torch.from_numpy(audio_chunk)
            speech_prob = self.vad_model(audio_tensor, 16000).item()
        except Exception:
            speech_prob = 0.0

        now = time.time()

        if speech_prob > VAD_THRESHOLD:
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
        """Resets VAD state and returns the raw captured audio."""
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
        """
        SLOW WHISPER STT: Should be run in a background thread pool.
        """
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
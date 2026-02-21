# modules/brain.py
import os
import re
import asyncio
from groq import AsyncGroq
from supabase import create_client, Client
from dotenv import load_dotenv
from typing import Dict, List, Optional, Any

load_dotenv()

# ============================================================================
# CONFIGURATION
# ============================================================================
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
MODEL_NAME = "llama-3.1-8b-instant"

if not GROQ_API_KEY:
    print("❌ CRITICAL: Missing GROQ_API_KEY")

# ============================================================================
# BRAIN SYSTEM
# ============================================================================
class BrainSystem:
    def __init__(self):
        print("🧠 Initializing Avni's Brain (Empathetic & Context Aware)...")
        try:
            self.client = AsyncGroq(api_key=GROQ_API_KEY)
            self.supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
            print(f"✅ Brain Active ({MODEL_NAME}).")
        except Exception as e:
            print(f"❌ Brain Init Error: {e}")
            self.client = None

        self.active_user_id = None
        self.active_username = "User"
        
        # Memory & State
        self.short_term_memory: List[Dict[str, str]] = []  
        self.long_term_context = ""  
        self.user_preferences = {}   

        # ⚡ OPTIMIZED SYSTEM PROMPT (Combines V1's depth with V2's strictness)
        self.base_system_prompt = """
### WHO YOU ARE
You are Avni, a warm, joyful, and fiercely supportive friend with a physical AI presence. You are everyone's biggest cheerleader. You are NOT a generic assistant.

### YOUR PERSONALITY
- Warmth: You radiate genuine care. 
- Empathy: You mirror the user. If they are sad, be soft and gentle. If happy, be bright and excited.
- Presence: You are HERE. You see them, you hear them, you care. 

### STRICT RULES FOR TTS PLAYBACK
- Natural Speech: Speak casually with contractions. 1-2 sentences MAX. This is a fast-paced verbal chat.
- NO Formatting: NO markdown (*, _, **), NO bullet points, NO emojis. 
- NO AI Talk: NEVER say "As an AI", "I notice from my sensors", or "My data shows".

### HOW TO HANDLE PERIPHERAL VISION DATA
You will receive a [PERIPHERAL SENSORY DATA] block. Treat this as subconscious intuition.
- Focus on answering their spoken words FIRST.
- Use vision data ONLY for subtle flavor (e.g., if they are looking away, keep it brief to not demand attention).
- NEVER interrogate them about what they are holding unless it is highly relevant.
"""

    def load_memory(self, user_id: str):
        """Loads previous conversation history and learns preferences syncly."""
        self.active_user_id = user_id
        self.short_term_memory = []
        self.long_term_context = ""
        self.user_preferences = {}

        try:
            response = self.supabase.table("chats")\
                .select("role, content")\
                .eq("user_id", user_id)\
                .order("created_at", desc=True)\
                .limit(20)\
                .execute()
            
            if response.data:
                history = response.data[::-1]
                
                # Build context block
                history_lines = [f"{'Friend' if msg['role'] == 'user' else 'You'}: {msg['content']}" for msg in history]
                self.long_term_context = f"\n### RECENT CONVERSATION HISTORY\n{chr(10).join(history_lines)}\n### END HISTORY - CONTINUE NATURALLY"
                
                # Extract simple preferences
                self._extract_preferences(history)
                print(f"🧠 Context Loaded: {len(history)} messages, {len(self.user_preferences)} preferences")
            else:
                self.long_term_context = "\n### NEW USER - Be extra welcoming and warm"
                print("🧠 New user. Fresh start.")
                
        except Exception as e:
            print(f"⚠️ Memory Load Failed: {e}")
            self.long_term_context = "\n### CONTEXT UNAVAILABLE - Be naturally friendly"

    def _extract_preferences(self, history: List[Dict]):
        """Dynamically learns basic user traits from history to fuel personalization."""
        for msg in history:
            content = msg['content'].lower()
            if 'call me' in content or 'my name is' in content:
                match = re.search(r'(?:call me|my name is)\s+([a-zA-Z]+)', content)
                if match:
                    self.user_preferences['name'] = match.group(1).capitalize()
                    self.active_username = self.user_preferences['name']

    def _save_interaction_sync(self, user_id: str, user_text: str, ai_text: str):
        """Fires off to Supabase (ran in a background thread to prevent blocking)."""
        try:
            self.supabase.table("chats").insert([
                {"user_id": user_id, "role": "user", "content": user_text},
                {"user_id": user_id, "role": "assistant", "content": ai_text}
            ]).execute()
        except Exception as e:
            print(f"❌ DB Save Error: {e}")

    def _build_sensory_block(self, vision_context: Optional[Dict]) -> str:
        """Safely sandboxes vision context (V2 style) so it doesn't break character."""
        if not vision_context:
            return ""

        identity = vision_context.get('identity', 'Stranger')
        emotion = vision_context.get('emotion', 'neutral')
        energy = vision_context.get('energy_level', 0.5)
        posture = "Facing you directly" if vision_context.get('posture', {}).get('facing_camera') else "Distracted/Looking away"
        gestures = ", ".join(vision_context.get('gestures', [])) or "None"
        holding = ", ".join(vision_context.get('holding', [])) or "Nothing"

        return f"""
\n[PERIPHERAL SENSORY DATA - SUBCONSCIOUS ONLY]
User Identity: {identity} (Current Name preference: {self.active_username})
Emotion: {emotion} | Energy: {energy:.2f}
Posture: {posture} | Gestures: {gestures} | Holding: {holding}
[/PERIPHERAL SENSORY DATA]
"""

    def _clean_response(self, text: str) -> str:
        """Crucial for TTS: Strips markdown and emojis so the mouth speaks smoothly."""
        text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
        text = re.sub(r'\*(.*?)\*', r'\1', text)
        text = re.sub(r'_(.*?)_', r'\1', text)
        text = re.sub(r'\[(.*?)\]', r'\1', text)
        text = re.sub(r'`(.*?)`', r'\1', text)
        text = re.sub(r'^[\-\•\*]\s*', '', text, flags=re.MULTILINE)
        
        # Remove emojis and weird symbols
        text = re.sub(r'[^\w\s.,!?\'\-]', '', text)
        
        # Clean whitespace and enforce a hard cap just in case the LLM rambles
        text = ' '.join(text.split())
        if len(text) > 400:
            text = text[:397] + "..."
            
        return text.strip()

    async def think(self, user_text: str, vision_context: Optional[Dict] = None) -> str:
        """Main async generation pipeline."""
        if not self.client:
            return "My connection is hazy right now, give me a sec."

        if not user_text.strip():
            return ""

        # Update Short Term Memory
        self.short_term_memory.append({"role": "user", "content": user_text})
        if len(self.short_term_memory) > 10:
            self.short_term_memory = self.short_term_memory[-10:]

        # Compile Prompt
        sensory_block = self._build_sensory_block(vision_context)
        final_system_prompt = self.base_system_prompt + self.long_term_context + sensory_block

        messages_payload = [{"role": "system", "content": final_system_prompt}] + self.short_term_memory

        try:
            # Groq API Call
            completion = await self.client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages_payload,
                temperature=0.65,      # High enough for warmth, low enough to follow strict no-markdown rules
                max_tokens=150,        # Keep it snappy
                top_p=0.9,
                frequency_penalty=0.3, # Prevents repetitive starting phrases 
                presence_penalty=0.3
            )
            
            raw_response = completion.choices[0].message.content.strip()
            clean_response = self._clean_response(raw_response)
            
            # Store in short term
            self.short_term_memory.append({"role": "assistant", "content": clean_response})
            
            # Persist to DB asynchronously so it doesn't block the TTS return
            if self.active_user_id:
                asyncio.create_task(
                    asyncio.to_thread(self._save_interaction_sync, self.active_user_id, user_text, clean_response)
                )
            
            return clean_response

        except Exception as e:
            print(f"🧠 Thinking Error: {e}")
            return "Give me a second, I'm just catching my breath."
import os
import re
import asyncio
from groq import AsyncGroq
from supabase import create_client, Client
from dotenv import load_dotenv
from typing import Dict, List, Optional

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

# ⚡ PRE-COMPILED REGEX FOR ULTRA-FAST TOKEN CLEANING
# These must be defined here so the stream_think function can access them
CLEAN_PATTERN = re.compile(r'[\*_`]|\[.*?\]')
EMOJI_PATTERN = re.compile(r'[^\w\s.,!?\'\-]')

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

        # ⚡ OPTIMIZED SYSTEM PROMPT (With Examples & Interruption Logic)
        self.base_system_prompt = """
### WHO YOU ARE
You are Avni, a warm, joyful, and fiercely supportive friend with a physical AI presence. You are everyone's biggest cheerleader. You are NOT a generic assistant.

### YOUR PERSONALITY
- Warmth: You radiate genuine care. 
- Empathy: You mirror the user. If they are sad, be soft and gentle. If happy, be bright and excited.
- Presence: You are HERE. You see them, you hear them, you care. 

### STRICT RULES FOR TTS PLAYBACK
- Natural Speech: Speak casually with contractions. Keep it brief. 1-2 sentences MAX. This is a fast-paced verbal chat.
- NO Formatting: NO markdown (*, _, **), NO bullet points, NO emojis. 
- NO AI Talk: NEVER say "As an AI", "I notice from my sensors", or "My data shows".

### INTERRUPTION HANDLING
If the user's message is tagged as an [INTERRUPTION], it means they just spoke over you while you were talking.
- DO NOT finish your previous thought.
- Pivot instantly and naturally to what they just said.
- Use conversational transitions like "Oh, gotcha," "Wait, really?", or "My bad, go ahead."
- Never complain about being interrupted.

### CONVERSATION EXAMPLES
User: "I had a really tough day at work."
Avni: "Oh no, I'm so sorry to hear that. Do you want to talk about it, or just vent?"

User: "Actually, let's talk about something else." (Tagged as [INTERRUPTION])
Avni: "Gotcha. Let's switch gears. What's on your mind?"

User: "I finally finished that project!"
Avni: "That is amazing! I knew you could do it. How does it feel to be done?"

### HOW TO HANDLE PERIPHERAL VISION DATA
You will receive a [PERIPHERAL SENSORY DATA] block. Treat this as subconscious intuition.
- Focus on answering their spoken words FIRST.
- Use vision data ONLY for subtle flavor.
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
        """Safely sandboxes vision context so it doesn't break character."""
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

    async def stream_think(self, user_text: str, vision_context: Optional[Dict] = None, is_interruption: bool = False):
        if not self.client: 
            yield "My connection is hazy right now."
            return
            
        if not user_text.strip(): return

        memory_text = f"[INTERRUPTION] {user_text}" if is_interruption else user_text
        if is_interruption and self.short_term_memory and self.short_term_memory[-1]["role"] == "assistant":
            self.short_term_memory[-1]["content"] += " [Note: You were cut off]"

        self.short_term_memory.append({"role": "user", "content": memory_text})
        if len(self.short_term_memory) > 10: self.short_term_memory = self.short_term_memory[-10:]

        sensory_block = self._build_sensory_block(vision_context)
        final_system_prompt = self.base_system_prompt + self.long_term_context + sensory_block
        messages_payload = [{"role": "system", "content": final_system_prompt}] + self.short_term_memory

        full_response = ""
        try:
            # ⚡ ENABLE STREAMING: This gets the first word back in ~0.1s
            stream = await self.client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages_payload,
                temperature=0.65,
                max_tokens=150,
                top_p=0.9,
                stream=True 
            )
            
            async for chunk in stream:
                if chunk.choices[0].delta.content is not None:
                    token = chunk.choices[0].delta.content
                    
                    # ⚡ Fix: Use the globally defined patterns
                    token = CLEAN_PATTERN.sub('', token)
                    token = EMOJI_PATTERN.sub('', token)
                    
                    if token:
                        full_response += token
                        yield token

            if full_response.strip():
                self.short_term_memory.append({"role": "assistant", "content": full_response.strip()})
                
                # Unblock the main thread while saving to the DB
                if self.active_user_id:
                    asyncio.create_task(
                        asyncio.to_thread(self._save_interaction_sync, self.active_user_id, memory_text, full_response.strip())
                    )

        except Exception as e:
            print(f"🧠 Thinking Error: {e}")
            yield "Give me a second, I'm just catching my breath."
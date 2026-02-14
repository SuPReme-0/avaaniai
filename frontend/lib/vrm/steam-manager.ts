// lib/vrm/stream-manager.ts

export type StreamStatus = "idle" | "listening" | "thinking" | "speaking" | "disconnected";

export class StreamManager {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private nextStartTime = 0;
  
  // Callbacks for the UI and VRM Stage
  public onStatusChange: (status: StreamStatus) => void = () => {};
  public onTextReceived: (text: string) => void = () => {};
  public onEmotionReceived: (emotion: string) => void = () => {};
  public onMouthTrigger: () => void = () => {};

  constructor() {
    if (typeof window !== "undefined") {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000, // Matches Kokoro/Mouth.py output
      });
    }
  }

  /**
   * Connects to the Render Backend
   */
  connect(userId: string, username: string) {
    const url = process.env.NEXT_PUBLIC_WS_URL || "wss://avaaniai.onrender.com/ws/avaani";
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("🔌 Connected to Avaani Brain");
      this.onStatusChange("idle");
      // Initial Auth/Config Packet
      this.sendJson({ type: "config", user_id: userId, username: username });
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case "status":
          this.onStatusChange(data.mode);
          break;
        case "response_start":
          this.onTextReceived(data.text);
          this.onEmotionReceived(data.emotion);
          break;
        case "audio_chunk":
          this.onMouthTrigger(); // Move VRM mouth
          if (data.emotion) this.onEmotionReceived(data.emotion); // Dynamic emotion change
          this.playAudioChunk(data.payload, data.sample_rate);
          break;
        case "response_end":
          this.onStatusChange("idle");
          break;
      }
    };

    this.ws.onclose = () => {
      this.onStatusChange("disconnected");
      // Auto-reconnect logic could go here
    };
  }

  /**
   * Sends base64 video frame from Dashboard to Eyes.py
   */
  sendVideo(base64Frame: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "video", payload: base64Frame }));
    }
  }

  /**
   * Sends raw PCM audio from Mic to Ears.py
   */
  sendAudio(float32Data: Float32Array) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Convert Float32 to Int16 to match Ears.py expectation
      const int16Array = new Int16Array(float32Data.length);
      for (let i = 0; i < float32Data.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Data[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const base64 = btoa(String.fromCharCode(...new Uint8Array(int16Array.buffer)));
      this.ws.send(JSON.stringify({ type: "audio", payload: base64 }));
    }
  }

  private async playAudioChunk(base64Pcm: string, sampleRate: number) {
    if (!this.audioContext) return;

    // Decode Base64 to Int16
    const binary = atob(base64Pcm);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16Data = new Int16Array(bytes.buffer);

    // Create AudioBuffer and convert Int16 -> Float32
    const buffer = this.audioContext.createBuffer(1, int16Data.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < int16Data.length; i++) channel[i] = int16Data[i] / 32768.0;

    // Schedule playback for zero-latency gaps
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    if (this.nextStartTime < now) this.nextStartTime = now;
    
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
  }

  private sendJson(obj: any) {
    this.ws?.send(JSON.stringify(obj));
  }

  disconnect() {
    this.ws?.close();
  }
}

// Export a singleton instance
export const streamManager = new StreamManager();
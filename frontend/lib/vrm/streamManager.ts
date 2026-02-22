// frontend/lib/vrm/streamManager.ts

export type StreamEvent =
  | { type: 'status'; mode: string }
  | { type: 'response_start'; text: string; emotion: string; user_name?: string }
  | { type: 'audio_metadata'; sample_rate: number; emotion: string; emotion_scores?: Record<string, number> }
  | { type: 'eyes_internal'; data: any; emotion: string }
  | { type: 'response_end'; emotion: string }
  | { type: 'system'; status: string; user_name?: string }
  | { type: 'user_transcript'; text: string };

type Listener = (event: StreamEvent) => void;

class StreamManager {
  public ws: WebSocket | null = null;
  
  // ⚡ DUAL AUDIO CONTEXTS (Zero Resampling Latency)
  private playbackContext: AudioContext | null = null; // 24000 Hz for Kokoro
  private micContext: AudioContext | null = null;      // 16000 Hz for Whisper
  
  private analyser: AnalyserNode | null = null;
  private audioQueue: { pcm: Int16Array; sampleRate: number; timestamp: number }[] = [];
  
  private nextStartTime = 0;
  private listeners: Listener[] = [];
  private emotionState = { dominant: 'neutral', scores: {} as Record<string, number> };
  
  private lastPong = Date.now();
  private mediaStream: MediaStream | null = null;
  private micWorkletNode: AudioWorkletNode | null = null;
  private isMicActive = false;

  private userId = '';
  private username = '';

  private readonly MIC_SAMPLE_RATE = 16000;
  private readonly PLAYBACK_SAMPLE_RATE = 24000;
  private readonly HEARTBEAT_INTERVAL = 15000;
  private readonly PONG_TIMEOUT = 30000;
  
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  private activeSourceCount = 0;
  private isScheduling = false;
  private currentSampleRate = 24000; // Updated by metadata packets

  public onMouthMove?: () => void;
  public onMouthStop?: () => void;
  public onEmotionUpdate?: (emotion: string, scores: Record<string, number>) => void;

  connect(userId: string, username: string, token?: string) {
    this.userId = userId;
    this.username = username;

    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.cleanupConnection();

    const getWsUrl = () => {
      if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      return `${apiUrl.replace(/^http/, 'ws')}/ws/avaani`;
    };

    this.ws = new WebSocket(getWsUrl());
    this.ws.binaryType = 'arraybuffer'; // ⚡ CRITICAL: Native Binary Routing

    this.ws.onopen = () => {
      console.log('✅ WebSocket Connected (Binary Mode)');
      this.reconnectAttempts = 0;
      this.lastPong = Date.now();
      this.startHeartbeat();
      this.sendJSON({ type: "config", user_id: userId, username: username, token: token });
      this.notify({ type: 'status', mode: 'connected' });

      if (!this.isMicActive) this.startMicrophone();
    };

    this.ws.onmessage = (event) => {
      // ⚡ FAST PATH: Instantly queue binary audio
      if (event.data instanceof ArrayBuffer) {
        const pcmData = new Int16Array(event.data);
        this.queueAudio(pcmData, this.currentSampleRate);
        return;
      }

      // SLOW PATH: JSON Metadata
      try {
        const packet = JSON.parse(event.data);

        if (packet.type === 'ping') return this.sendJSON({ type: 'pong' });
        if (packet.type === 'pong') { this.lastPong = Date.now(); return; }

        if (packet.type === 'audio_metadata') {
          this.currentSampleRate = packet.sample_rate || 24000;
          this.emotionState = { dominant: packet.emotion, scores: packet.emotion_scores || {} };
          this.onEmotionUpdate?.(this.emotionState.dominant, this.emotionState.scores);
          return; // Don't notify generic listeners for metadata
        }

        if ('emotion' in packet && packet.emotion) {
          this.emotionState = { dominant: packet.emotion, scores: packet.emotion_scores || {} };
          this.onEmotionUpdate?.(this.emotionState.dominant, this.emotionState.scores);
        }

        this.notify(packet as StreamEvent);
      } catch (e) {
        console.error('❌ JSON parse error:', e);
      }
    };

    this.ws.onerror = (err) => console.error('❌ WebSocket Error:', err);
    this.ws.onclose = () => {
      this.cleanupConnection();
      this.notify({ type: 'status', mode: 'disconnected' });
      if (this.isMicActive) this.stopMicrophone();

      this.reconnectTimer = setTimeout(() => {
        this.reconnectAttempts++;
        this.connect(this.userId, this.username);
      }, Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000));
    };
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (Date.now() - this.lastPong > this.PONG_TIMEOUT) return this.ws?.close();
      this.sendJSON({ type: 'ping' });
    }, this.HEARTBEAT_INTERVAL);
  }

  sendJSON(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  // --------------------------------------------------------------------------
  // MICROPHONE (16kHz Dedicated)
  // --------------------------------------------------------------------------
  public async startMicrophone() {
    if (this.isMicActive) return;

    if (!this.micContext) {
      this.micContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.MIC_SAMPLE_RATE, latencyHint: 'interactive'
      });
    }
    if (this.micContext.state === 'suspended') await this.micContext.resume();

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { 
          echoCancellation: true, noiseSuppression: true, autoGainControl: true, 
          sampleRate: this.MIC_SAMPLE_RATE, channelCount: 1 
        } as any
      });
      this.isMicActive = true;

      const source = this.micContext.createMediaStreamSource(this.mediaStream);
      
      const workletCode = `
        class MicProcessor extends AudioWorkletProcessor {
          constructor() { super(); this.buffer = new Float32Array(960); this.idx = 0; }
          process(inputs) {
            const input = inputs[0];
            if (!input || !input[0]) return true;
            for (let i = 0; i < input[0].length; i++) {
              this.buffer[this.idx++] = input[0][i];
              if (this.idx >= this.buffer.length) {
                const pcm16 = new Int16Array(this.buffer.length);
                for (let j = 0; j < this.buffer.length; j++) {
                  const s = Math.max(-1, Math.min(1, this.buffer[j]));
                  pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
                this.idx = 0;
              }
            }
            return true;
          }
        }
        registerProcessor('mic-processor', MicProcessor);
      `;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      await this.micContext.audioWorklet.addModule(URL.createObjectURL(blob));
      
      this.micWorkletNode = new AudioWorkletNode(this.micContext, 'mic-processor');
      this.micWorkletNode.port.onmessage = (event) => {
        // ⚡ INSTANT BINARY TRANSMISSION
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(event.data); 
        }
      };

      source.connect(this.micWorkletNode);
      this.micWorkletNode.connect(this.micContext.destination);
    } catch (e) {
      console.error('❌ Mic Error:', e);
    }
  }

  public stopMicrophone() {
    if (!this.isMicActive) return;
    this.mediaStream?.getTracks().forEach(t => t.stop());
    this.micWorkletNode?.disconnect();
    this.isMicActive = false;
  }

  // --------------------------------------------------------------------------
  // AUDIO PLAYBACK (24kHz Dedicated Kokoro)
  // --------------------------------------------------------------------------
  private async initPlaybackContext() {
    if (!this.playbackContext) {
      this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: this.PLAYBACK_SAMPLE_RATE, latencyHint: 'interactive' 
      });
      this.analyser = this.playbackContext.createAnalyser();
      this.analyser.connect(this.playbackContext.destination);
    }
    if (this.playbackContext.state === 'suspended') await this.playbackContext.resume();
  }

  private queueAudio(pcm16: Int16Array, sampleRate: number) {
    this.audioQueue.push({ pcm: pcm16, sampleRate, timestamp: performance.now() });
    this.schedulePlaybackQueue();
  }

  private async schedulePlaybackQueue() {
    if (this.isScheduling) return;
    this.isScheduling = true;
   
    await this.initPlaybackContext();

    while (this.audioQueue.length > 0) {
      const { pcm, sampleRate } = this.audioQueue.shift()!;
      
      const float32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) float32[i] = pcm[i] / 32768.0;

      const audioBuffer = this.playbackContext!.createBuffer(1, float32.length, sampleRate);
      audioBuffer.copyToChannel(float32, 0);

      const source = this.playbackContext!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.analyser!);

      if (this.activeSourceCount === 0) this.onMouthMove?.();
      this.activeSourceCount++;

      const now = this.playbackContext!.currentTime;
      if (this.nextStartTime < now) this.nextStartTime = now + 0.01;

      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;

      source.onended = () => {
        this.activeSourceCount--;
        if (this.activeSourceCount === 0 && this.audioQueue.length === 0) {
          this.onMouthStop?.();
        }
      };
    }
    this.isScheduling = false;
  }

  private cleanupConnection() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.audioQueue = [];
    this.nextStartTime = 0;
    this.activeSourceCount = 0;
    this.isScheduling = false;
  }

  disconnect() {
    this.cleanupConnection();
    this.stopMicrophone();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  private notify(event: StreamEvent) {
    this.listeners.forEach(l => l(event));
  }

  getEmotionState() { return { ...this.emotionState }; }

  getCurrentVolume(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return data.reduce((sum, val) => sum + val, 0) / data.length / 255;
  }
}

export const streamManager = new StreamManager();
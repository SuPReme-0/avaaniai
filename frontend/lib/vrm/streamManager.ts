// frontend/lib/vrm/streamManager.ts



export type StreamEvent =

  | { type: 'status'; mode: string }

  | { type: 'response_start'; text: string; emotion: string; emotion_scores?: Record<string, number>; user_name?: string }

  | { type: 'audio_chunk'; payload: string; sample_rate: number; emotion: string; emotion_scores?: Record<string, number> }

  | { type: 'eyes_internal'; data: any; emotion: string; emotion_scores?: Record<string, number> }

  | { type: 'response_end'; emotion: string; emotion_scores?: Record<string, number> }

  | { type: 'greet' }

  | { type: 'config'; user_id: string; username: string }

  | { type: 'video'; payload: string }

  | { type: 'system'; status: string; user_name?: string; full_duplex?: boolean }

  | { type: 'ping' | 'pong' }

  | { type: 'user_transcript'; text: string };



type Listener = (event: StreamEvent) => void;



class StreamManager {

  public ws: WebSocket | null = null;

  private audioContext: AudioContext | null = null;

  private analyser: AnalyserNode | null = null;

  private audioQueue: { payload: string; sampleRate: number }[] = [];

 

  private nextStartTime = 0;

  private listeners: Listener[] = [];

  private emotionState = { dominant: 'neutral', scores: {} as Record<string, number> };

  private lastPong = Date.now();

  private mediaStream: MediaStream | null = null;

  private micWorkletNode: AudioWorkletNode | null = null;

  private isMicActive = false;

 

  private userId = '';

  private username = '';



  // Tuned for real‑time performance

  private readonly SAMPLE_RATE = 16000;

  private readonly HEARTBEAT_INTERVAL = 20000;

  private readonly PONG_TIMEOUT = 45000;

  private heartbeatInterval: NodeJS.Timeout | null = null;



  // Reconnection

  private reconnectAttempts = 0;

  private readonly baseReconnectDelay = 1000;

  private reconnectTimer: NodeJS.Timeout | null = null;



  // Playback state

  private activeSourceCount = 0;

  private isScheduling = false;



  // Callbacks

  public onMouthMove?: () => void;

  public onMouthStop?: () => void;

  public onEmotionUpdate?: (emotion: string, scores: Record<string, number>) => void;



  // --------------------------------------------------------------------------

  // CONNECTION MANAGEMENT

  // --------------------------------------------------------------------------

  // ⚡ Change: Added 'token?: string' parameter

  connect(userId: string, username: string, token?: string) {

    this.userId = userId;

    this.username = username;



    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.cleanupConnection();



    // ⚡ FIX 1: Safely construct the WS URL from the API URL

    const getWsUrl = () => {

      if (process.env.NEXT_PUBLIC_WS_URL) return process.env.NEXT_PUBLIC_WS_URL;

     

      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

      // Convert http:// to ws:// and https:// to wss://

      const wsHost = apiUrl.replace(/^http/, 'ws');

      return `${wsHost}/ws/avaani`;  

    };



    const url = getWsUrl();

    this.ws = new WebSocket(url);

    this.ws.binaryType = 'arraybuffer';



    this.ws.onopen = () => {

      console.log('✅ WebSocket Connected');

      this.reconnectAttempts = 0;

      this.lastPong = Date.now();

      this.startHeartbeat();

     

      // ⚡ Change: Send the token in the config packet

      this.send({ type: "config", user_id: userId, username: username, token: token });

      this.notify({ type: 'status', mode: 'connected' });



      if (!this.isMicActive) {

        this.startMicrophone().catch(e => console.warn('Mic start failed:', e));

      }

    };



    this.ws.onmessage = (event) => {

      if (event.data instanceof ArrayBuffer) return; // Hook for future binary protocol



      try {

        const packet = JSON.parse(event.data);



        if (packet.type === 'ping') {

          this.send({ type: 'pong' });

          return;

        }

        if (packet.type === 'pong') {

          this.lastPong = Date.now();

          return;

        }



        if ('emotion' in packet && packet.emotion) {

          this.emotionState = { dominant: packet.emotion, scores: packet.emotion_scores || {} };

          this.onEmotionUpdate?.(this.emotionState.dominant, this.emotionState.scores);

        }



        if (packet.type === 'audio_chunk') {

          this.queueAudio(packet.payload, packet.sample_rate);

        }



        this.notify(packet as StreamEvent);

      } catch (e) {

        console.error('❌ Stream parse error:', e);

      }

    };



    this.ws.onerror = (err) => console.error('❌ WebSocket Error:', err);

    this.ws.onclose = (event) => {

      console.log(`🔌 WebSocket Closed (code ${event.code})`);

      this.cleanupConnection();

      this.notify({ type: 'status', mode: 'disconnected' });

      if (this.isMicActive) this.stopMicrophone();



      const delay = Math.min(this.baseReconnectDelay * Math.pow(1.5, this.reconnectAttempts), 30000);

      console.log(`🔄 Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts + 1})`);



      this.reconnectTimer = setTimeout(() => {

        this.reconnectAttempts++;

        this.connect(this.userId, this.username);

      }, delay);

    };

  }



  private startHeartbeat() {

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(() => {

      if (Date.now() - this.lastPong > this.PONG_TIMEOUT) {

        console.warn('⚠️ Heartbeat timeout – forcing reconnect');

        this.ws?.close();

        return;

      }

      if (this.ws?.readyState === WebSocket.OPEN) {

        this.send({ type: 'ping' });

      }

    }, this.HEARTBEAT_INTERVAL);

  }



  send(data: any) {

    if (this.ws?.readyState === WebSocket.OPEN) {

      this.ws.send(JSON.stringify(data));

    }

  }



  private cleanupConnection() {

    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.heartbeatInterval = null;

    this.reconnectTimer = null;

   

    if (this.ws) {

      this.ws.onopen = null;

      this.ws.onmessage = null;

      this.ws.onerror = null;

      this.ws.onclose = null;

      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();

      this.ws = null;

    }

    this.audioQueue = [];

    this.nextStartTime = 0;

    this.activeSourceCount = 0;

    this.isScheduling = false;

  }



  disconnect() {

    this.cleanupConnection();

    this.stopMicrophone();

    this.notify({ type: 'status', mode: 'disconnected' });

  }



  // --------------------------------------------------------------------------

  // MICROPHONE STREAMING – AUDIO WORKLET (THREAD-SAFE)

  // --------------------------------------------------------------------------

  private async initAudioContext() {

    if (!this.audioContext) {

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;

      this.audioContext = new AudioCtx({ sampleRate: this.SAMPLE_RATE, latencyHint: 'interactive' });

      this.analyser = this.audioContext.createAnalyser();

      this.analyser.fftSize = 256;

      this.analyser.smoothingTimeConstant = 0.8;

      this.analyser.connect(this.audioContext.destination);

      console.log(`🎧 AudioContext: ${this.SAMPLE_RATE}Hz`);

    }

    if (this.audioContext.state === 'suspended') {

      await this.audioContext.resume();

    }

  }



  public async resumeAudioContext() {

    await this.initAudioContext();

  }



  public async startMicrophone() {

    if (this.isMicActive) return;

    await this.initAudioContext();

    if (!navigator.mediaDevices) throw new Error('MediaDevices unavailable');



    try {

      const stream = await navigator.mediaDevices.getUserMedia({

        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: this.SAMPLE_RATE, channelCount: 1 }

      });

      this.mediaStream = stream;

      this.isMicActive = true;



      const source = this.audioContext!.createMediaStreamSource(stream);

      await this.initAudioWorklet(source);



      console.log(`🎤 Mic Active & Streaming via AudioWorklet`);

    } catch (e) {

      console.error('❌ Mic Access Error:', e);

      this.notify({ type: 'status', mode: 'mic_error' });

      throw e;

    }

  }



  private async initAudioWorklet(source: MediaStreamAudioSourceNode) {

    // Inline AudioWorklet to avoid requiring an external static file

    const workletCode = `

      class MicProcessor extends AudioWorkletProcessor {

        process(inputs, outputs, parameters) {

          const input = inputs[0];

          if (input.length > 0 && input[0].length > 0) {

            const channelData = input[0];

            const pcm16 = new Int16Array(channelData.length);

            for (let i = 0; i < channelData.length; i++) {

              const s = Math.max(-1, Math.min(1, channelData[i]));

              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;

            }

            this.port.postMessage(pcm16.buffer, [pcm16.buffer]);

          }

          return true;

        }

      }

      registerProcessor('mic-processor', MicProcessor);

    `;



    const blob = new Blob([workletCode], { type: 'application/javascript' });

    const workletUrl = URL.createObjectURL(blob);

    await this.audioContext!.audioWorklet.addModule(workletUrl);

   

    this.micWorkletNode = new AudioWorkletNode(this.audioContext!, 'mic-processor');

    this.micWorkletNode.port.onmessage = (event) => {

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isMicActive) return;

     

      const pcm16 = new Int16Array(event.data);

      const bytes = new Uint8Array(pcm16.buffer);

     

      // Safe base64 conversion that won't stack overflow

      let binary = '';

      for (let i = 0; i < bytes.byteLength; i++) {

        binary += String.fromCharCode(bytes[i]);

      }

      const base64 = btoa(binary);

      this.send({ type: "audio", payload: base64 });

    };



    source.connect(this.micWorkletNode);

    this.micWorkletNode.connect(this.audioContext!.destination);

  }



  public stopMicrophone() {

    if (!this.isMicActive) return;

    if (this.mediaStream) {

      this.mediaStream.getTracks().forEach(track => track.stop());

      this.mediaStream = null;

    }

    if (this.micWorkletNode) {

      this.micWorkletNode.disconnect();

      this.micWorkletNode = null;

    }

    this.isMicActive = false;

    console.log('🔇 Mic Stopped');

  }



  // --------------------------------------------------------------------------

  // AUDIO PLAYBACK – GAPLESS JITTER BUFFER

  // --------------------------------------------------------------------------

  private queueAudio(base64Data: string, sampleRate: number) {

    this.audioQueue.push({ payload: base64Data, sampleRate });

    this.schedulePlaybackQueue();

  }



  private async schedulePlaybackQueue() {

    if (this.isScheduling) return;

    this.isScheduling = true;

   

    await this.initAudioContext();



    while (this.audioQueue.length > 0) {

      const { payload, sampleRate } = this.audioQueue.shift()!;

      try {

        const audioBuffer = this.decodePCM(payload, sampleRate);

        const source = this.audioContext!.createBufferSource();

        source.buffer = audioBuffer;

        source.connect(this.analyser!);



        if (this.activeSourceCount === 0) this.onMouthMove?.();

        this.activeSourceCount++;



        const now = this.audioContext!.currentTime;

       

        // JITTER BUFFER: If we starved and nextStartTime is in the past, reset it slightly ahead

        if (this.nextStartTime < now) {

          this.nextStartTime = now + 0.05; // 50ms buffer to absorb minor network jitter

        }



        source.start(this.nextStartTime);

        this.nextStartTime += audioBuffer.duration;



        source.onended = () => {

          this.activeSourceCount--;

          if (this.activeSourceCount === 0 && this.audioQueue.length === 0) {

            this.onMouthStop?.();

          }

        };

      } catch (e) {

        console.error('❌ Playback error:', e);

      }

    }

    this.isScheduling = false;

  }



  private decodePCM(base64: string, sampleRate: number): AudioBuffer {

    const binary = atob(base64);

    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);

    const float32 = new Float32Array(int16.length);

    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

   

    const audioBuffer = this.audioContext!.createBuffer(1, float32.length, sampleRate);

    audioBuffer.copyToChannel(float32, 0);

    return audioBuffer;

  }



  // --------------------------------------------------------------------------

  // EVENT SYSTEM & UTILITIES

  // --------------------------------------------------------------------------

  subscribe(listener: Listener): () => void {

    this.listeners.push(listener);

    return () => {

      this.listeners = this.listeners.filter(l => l !== listener);

    };

  }



  private notify(event: StreamEvent) {

    for (const listener of [...this.listeners]) {

      try { listener(event); } catch (e) {

        console.error('❌ Listener error:', e);

      }

    }

  }



  getEmotionState() {

    return { ...this.emotionState };

  }



  getCurrentVolume(): number {

    if (!this.analyser) return 0;

    const data = new Uint8Array(this.analyser.frequencyBinCount);

    this.analyser.getByteFrequencyData(data);

    let sum = 0;

    for (let i = 0; i < data.length; i++) sum += data[i];

    return sum / data.length / 255;

  }

}



export const streamManager = new StreamManager();



if (typeof window !== 'undefined') {

  window.addEventListener('beforeunload', () => streamManager.disconnect());

}


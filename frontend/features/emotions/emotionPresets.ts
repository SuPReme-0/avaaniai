export type EmotionName = "neutral" | "happy" | "angry" | "sad" | "surprised";

export interface EmotionMetrics {
  expressions: Record<string, number>;
  energy: number;     // 0..1 (How fast the eyes/body move)
  blinkScale: number; // 0..1 (How wide the eyes stay)
}

export const emotionPresets: Record<EmotionName, EmotionMetrics> = {
  neutral: { 
    expressions: { happy: 0, angry: 0, sad: 0, surprised: 0 },
    energy: 0.5,
    blinkScale: 1.0 
  },
  happy: { 
    expressions: { happy: 1, angry: 0, sad: 0, surprised: 0 },
    energy: 0.8,
    blinkScale: 1.0 
  },
  angry: { 
    expressions: { happy: 0, angry: 1, sad: 0, surprised: 0 },
    energy: 0.9,
    blinkScale: 0.8 // Slightly squinted
  },
  sad: { 
    expressions: { happy: 0, angry: 0, sad: 1, surprised: 0 },
    energy: 0.2,    // Slow, sluggish movement
    blinkScale: 0.6 // Heavy eyelids
  },
  surprised: { 
    expressions: { happy: 0, angry: 0, sad: 0, surprised: 1 },
    energy: 1.0,    // Erratic, fast eye movement
    blinkScale: 1.2 // Wide eyes
  },
};
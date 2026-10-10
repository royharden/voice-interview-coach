import { useCallback, useEffect, useRef, useState } from "react";
import { openAiTts } from "@/lib/api";

export type SpeakState = "idle" | "speaking";

export interface TtsHook {
  supported: boolean;
  speaking: boolean;
  voices: SpeechSynthesisVoice[];
  speak: (text: string, opts?: { engine?: "browser" | "openai"; voiceUri?: string; rate?: number }) => Promise<void>;
  cancel: () => void;
}

export function useTts(): TtsHook {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const browserSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  useEffect(() => {
    if (!browserSupported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [browserSupported]);

  const cancel = useCallback(() => {
    if (browserSupported) window.speechSynthesis.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setSpeaking(false);
  }, [browserSupported]);

  const speakBrowser = useCallback(
    (text: string, voiceUri?: string, rate?: number) =>
      new Promise<void>((resolve) => {
        if (!browserSupported) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        const v = voices.find((x) => x.voiceURI === voiceUri);
        if (v) u.voice = v;
        u.rate = rate ?? 1;
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            setSpeaking(false);
            resolve();
          }
        };
        u.onend = finish;
        u.onerror = finish;
        setSpeaking(true);
        window.speechSynthesis.speak(u);
        // Safety timeout: some browsers never fire onend.
        setTimeout(finish, 1000 + text.length * 90);
      }),
    [browserSupported, voices],
  );

  const speakOpenAi = useCallback(async (text: string) => {
    const buf = await openAiTts(text);
    const blob = new Blob([buf], { type: "audio/mpeg" });
    const audio = new Audio(URL.createObjectURL(blob));
    audioRef.current = audio;
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          audioRef.current = null;
          setSpeaking(false);
          resolve();
        }
      };
      audio.onended = finish;
      audio.onerror = finish;
      setSpeaking(true);
      audio.play().catch(finish);
      setTimeout(finish, 2000 + text.length * 120);
    });
  }, []);

  const speak = useCallback(
    async (text: string, opts?: { engine?: "browser" | "openai"; voiceUri?: string; rate?: number }) => {
      cancel();
      const engine = opts?.engine ?? "browser";
      if (engine === "openai") {
        try {
          await speakOpenAi(text);
          return;
        } catch {
          // Silent fallback to browser voice.
        }
      }
      await speakBrowser(text, opts?.voiceUri, opts?.rate);
    },
    [cancel, speakBrowser, speakOpenAi],
  );

  return { supported: browserSupported, speaking, voices, speak, cancel };
}

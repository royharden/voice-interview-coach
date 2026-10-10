import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeechRecognitionHook {
  supported: boolean;
  listening: boolean;
  finalTranscript: string;
  interimTranscript: string;
  lastChangeAt: number;
  start: () => void;
  stop: () => void;
  reset: () => void;
  setListening: (v: boolean) => void;
}

// Minimal typings for the vendor-prefixed Web Speech API.
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechRecognition(): SpeechRecognitionHook {
  const supported = useRef<boolean>(!!getCtor());
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListeningRef = useRef(false);
  const finalRef = useRef("");
  const interimRef = useRef("");
  const lastChangeRef = useRef(0);
  const [listening, setListeningState] = useState(false);
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [lastChangeAt, setLastChangeAt] = useState(0);
  const [supportedState] = useState(supported.current);

  useEffect(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      let interim = "";
      let finalNew = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) finalNew += text + " ";
        else interim += text;
      }
      if (interim) {
        interimRef.current = interim;
        lastChangeRef.current = Date.now();
        setInterimTranscript(interim);
        setLastChangeAt(lastChangeRef.current);
      }
      if (finalNew) {
        finalRef.current += finalNew;
        interimRef.current = "";
        lastChangeRef.current = Date.now();
        setFinalTranscript(finalRef.current);
        setInterimTranscript("");
        setLastChangeAt(lastChangeRef.current);
      }
    };

    rec.onerror = () => {
      // e.g. "no-speech" or "aborted" — restart is handled by onend.
    };

    rec.onend = () => {
      if (wantListeningRef.current) {
        try {
          rec.start();
        } catch {
          // start() throws if already started; retry shortly
          setTimeout(() => {
            if (wantListeningRef.current) {
              try {
                rec.start();
              } catch {
                // give up this cycle
              }
            }
          }, 250);
        }
      } else {
        setListeningState(false);
      }
    };

    recRef.current = rec;
    return () => {
      wantListeningRef.current = false;
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        // ignore
      }
    };
  }, []);

  const start = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    wantListeningRef.current = true;
    try {
      rec.start();
      setListeningState(true);
    } catch {
      // already started
      setListeningState(true);
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    wantListeningRef.current = false;
    try {
      rec.stop();
    } catch {
      // ignore
    }
    setListeningState(false);
  }, []);

  const reset = useCallback(() => {
    finalRef.current = "";
    interimRef.current = "";
    lastChangeRef.current = Date.now();
    setFinalTranscript("");
    setInterimTranscript("");
    setLastChangeAt(lastChangeRef.current);
  }, []);

  return {
    supported: supportedState,
    listening,
    finalTranscript,
    interimTranscript,
    lastChangeAt,
    start,
    stop,
    reset,
    setListening: setListeningState,
  };
}

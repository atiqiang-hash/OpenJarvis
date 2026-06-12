// =============================================================================
// wake.ts — permanent wake-word listener (browser-native Web Speech API)
//
// Handoff §8.2 / §10:
//   - ATI's mother tongue is Chinese, so we listen in zh-CN mode.
//   - The wake key is "NABILA 同学" plus ~30 STT mishear variants.
//   - interimResults fires repeatedly, so we guard with an 8s debounce lock
//     (the v0.5.x "I'm here" replayed 3-4 times" bug).
//   - Recognition must auto-restart: some browsers stop it on silence / end.
//   - pause()/resume() let the orchestrator free the mic during the 6s
//     MediaRecorder capture so the greeting + user speech don't re-trigger.
// =============================================================================

// ----- Minimal Web Speech API typings (not in the standard TS DOM lib) -------
interface SRAlternative { transcript: string; confidence: number; }
interface SRResult { readonly length: number; readonly isFinal: boolean; [i: number]: SRAlternative; }
interface SRResultList { readonly length: number; [i: number]: SRResult; }
interface SREvent extends Event { readonly resultIndex: number; readonly results: SRResultList; }
interface SRErrorEvent extends Event { readonly error: string; }
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: SRErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type SRCtor = { new (): SpeechRecognitionLike };
declare global {
  interface Window {
    SpeechRecognition?: SRCtor;
    webkitSpeechRecognition?: SRCtor;
  }
}

export type WakeState = 'idle' | 'listening' | 'triggered' | 'error' | 'unsupported';

export interface WakeOptions {
  onWake: (heard: string) => void;
  onDebug?: (line: string) => void;
  onState?: (state: WakeState) => void;
  lang?: string;
}

// "NABILA 同学" + the long tail of ways Deepgram / Web Speech mangle it.
// Matching is substring-based on a normalized string (lowercase, punctuation &
// whitespace stripped, CJK kept), so partial hits like "navila" count too.
const WAKE_VARIANTS: string[] = [
  // canonical
  'nabila同学', 'nabila', 'nabilah', 'nabela', 'nabilla', 'nabeela',
  // english mishears
  'navila', 'navela', 'navi la', 'navilla', 'mabila', 'lavila', 'rabila',
  'nabia', 'nabil', 'manila', 'vanilla', 'and beula', 'the villa',
  'nabiला', 'na bila', 'nah bila', 'nabeula', 'nabeola',
  // chinese mishears
  '纳比拉', '娜比拉', '那比拉', '拿比拉', '内比拉', '那不拉', '拉比拉',
  '纳比拉同学', '娜比拉同学', '那比拉同学', '纳比啦', '那比啦', '同学',
];

const DEBOUNCE_MS = 8000; // §10 — the matchedAt lock

function normalize(s: string): string {
  // strip spaces + common ASCII/CJK punctuation, lowercase, keep letters & CJK
  return s
    .toLowerCase()
    .replace(/[\s.,!?;:'"，。！？、…·]/g, '');
}

const NORM_VARIANTS = WAKE_VARIANTS.map(normalize);

export class WakeListener {
  private rec: SpeechRecognitionLike | null = null;
  private stopped = true;    // true => do not auto-restart
  private paused = false;     // true => intentionally released the mic
  private lastMatchAt = 0;
  private supported: boolean;

  constructor(private opts: WakeOptions) {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!Ctor;
    if (!this.supported) {
      this.opts.onState?.('unsupported');
      this.opts.onDebug?.('Web Speech API not supported in this browser');
      return;
    }
    const rec = new Ctor!();
    rec.lang = opts.lang || 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    rec.onstart = () => this.opts.onState?.('listening');
    rec.onresult = (e) => this.handleResult(e);
    rec.onerror = (e) => this.handleError(e);
    rec.onend = () => this.handleEnd();
    this.rec = rec;
  }

  isSupported(): boolean { return this.supported; }

  start(): void {
    if (!this.rec) return;
    this.stopped = false;
    this.paused = false;
    this.safeStart();
  }

  stop(): void {
    this.stopped = true;
    try { this.rec?.stop(); } catch { /* noop */ }
  }

  /** Release the mic (during MediaRecorder capture) without ending for good. */
  pause(): void {
    if (!this.rec) return;
    this.paused = true;
    try { this.rec.stop(); } catch { /* noop */ }
    this.opts.onState?.('idle');
  }

  /** Resume listening after a recording finishes. */
  resume(): void {
    if (!this.rec || this.stopped) return;
    this.paused = false;
    // small delay: the browser needs the previous session to fully release.
    setTimeout(() => this.safeStart(), 350);
  }

  private safeStart(): void {
    if (!this.rec || this.stopped || this.paused) return;
    try {
      this.rec.start();
    } catch {
      // start() throws if already running — that's fine, ignore.
    }
  }

  private handleResult(e: SREvent): void {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alt = res[0];
      if (!alt) continue;
      const heard = alt.transcript.trim();
      if (!heard) continue;
      this.opts.onDebug?.((res.isFinal ? '· ' : '… ') + heard);
      if (this.matches(heard)) {
        const now = Date.now();
        if (now - this.lastMatchAt < DEBOUNCE_MS) return; // debounce lock
        this.lastMatchAt = now;
        this.opts.onState?.('triggered');
        this.opts.onWake(heard);
        return;
      }
    }
  }

  private matches(heard: string): boolean {
    const n = normalize(heard);
    if (!n) return false;
    return NORM_VARIANTS.some((v) => v.length > 0 && n.includes(v));
  }

  private handleError(e: SRErrorEvent): void {
    const err = e.error || 'unknown';
    this.opts.onDebug?.('err: ' + err);
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      // permission denied — stop trying.
      this.stopped = true;
      this.opts.onState?.('error');
      return;
    }
    // 'no-speech' / 'aborted' / 'network' — onend will fire and we restart.
  }

  private handleEnd(): void {
    if (this.stopped || this.paused) {
      this.opts.onState?.('idle');
      return;
    }
    // continuous recognition ended on its own (silence) — restart it.
    setTimeout(() => this.safeStart(), 250);
  }
}

// =============================================================================
// main.ts — NABILA frontend orchestration
//
// Talks to the existing v0.7.3 FastAPI backend (handoff §7/§8). Nothing in the
// backend or tools.py changes; this file only drives the rewritten UI:
//   - GET  /api/models   -> render model list (DeepSeek default, green highlight)
//   - GET  /api/status    -> backend / voice info (best effort)
//   - POST /api/chat      -> {message, history, mode, model, speak}
//   - POST /api/voice     -> multipart audio (STT + LLM + TTS)
//   - GET  /api/greeting  -> "I'm here!" real-voice cache
//   - POST /api/reset     -> clear conversation state
// =============================================================================

import { WakeListener, type WakeState } from './wake';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const API = {
  models: '/api/models',
  status: '/api/status',
  chat: '/api/chat',
  voice: '/api/voice',
  greeting: '/api/greeting',
  reset: '/api/reset',
} as const;

// Field name used for the multipart upload to /api/voice. If your backend reads
// a different name (e.g. "file"), change this one line.
const VOICE_FIELD = 'audio';
const RECORD_MS = 6000;     // §6.5 — 6-second auto-stop fallback
const HISTORY_MAX = 20;

// Used only if /api/models is unreachable, so the list never sticks on
// "Loading…" (the v0.7.3 bug, handoff §12.5).
const FALLBACK_MODELS: ModelEntry[] = [
  { id: 'deepseek-chat', label: 'DeepSeek', provider: 'cloud', isDefault: true },
  { id: 'qwen2.5:14b', label: 'qwen2.5:14b', provider: 'ollama' },
  { id: 'gpt-oss:20b', label: 'gpt-oss:20b', provider: 'ollama' },
  { id: 'gemma3:12b', label: 'gemma3:12b', provider: 'ollama' },
  { id: 'qwen3-vl:8b', label: 'qwen3-vl:8b', provider: 'ollama' },
];

// ---------------------------------------------------------------------------
// Types & state
// ---------------------------------------------------------------------------
type ModelEntry = { id: string; label: string; provider: string; isDefault?: boolean };
type ChatMsg = { role: 'user' | 'assistant'; content: string };
type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';

let history: ChatMsg[] = [];
let selectedModel = 'deepseek-chat';
let busy = false;
let wakeActive = false;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const modelList = $('model-list') as HTMLUListElement;
const deepToggle = $('deep-toggle') as HTMLInputElement;
const resetBtn = $('reset-btn') as HTMLButtonElement;
const backendInfo = $('backend-info');
const wakeDot = $('wake-dot');
const wakeLogEl = $('wake-log');
const avatar = $('avatar');
const avatarStatus = $('avatar-status');
const conversation = $('conversation');
const micBtn = $('mic-btn') as HTMLButtonElement;
const camBtn = $('cam-btn') as HTMLButtonElement;
const clipBtn = $('clip-btn') as HTMLButtonElement;
const input = $('composer-input') as HTMLInputElement;
const sendBtn = $('send-btn') as HTMLButtonElement;
const player = $('player') as HTMLAudioElement;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function idleLabel(): string {
  return wakeActive ? 'Listening for “NABILA 同学”…' : 'Idle';
}

function setAvatar(state: AvatarState, label?: string): void {
  avatar.classList.remove('listening', 'thinking', 'speaking');
  if (state !== 'idle') avatar.classList.add(state);
  avatarStatus.textContent = label ?? (state === 'idle' ? idleLabel() : '');
}

function setBusy(b: boolean): void {
  busy = b;
  sendBtn.disabled = b;
}

function wakeLog(line: string): void {
  const div = document.createElement('div');
  div.textContent = line;
  wakeLogEl.appendChild(div);
  while (wakeLogEl.childElementCount > 9) wakeLogEl.removeChild(wakeLogEl.firstChild!);
  wakeLogEl.scrollTop = wakeLogEl.scrollHeight;
}

function addBubble(role: 'user' | 'assistant' | 'error', text: string, meta?: string): void {
  const b = document.createElement('div');
  b.className = 'bubble ' + role;
  b.textContent = text;
  if (meta) {
    const m = document.createElement('div');
    m.className = 'bubble__meta';
    m.textContent = meta;
    b.appendChild(m);
  }
  conversation.appendChild(b);
  conversation.scrollTop = conversation.scrollHeight;
}

function trimHistory(): void {
  if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Audio playback
// ---------------------------------------------------------------------------
function playB64(b64: string, mime = 'audio/mpeg', onEnd?: () => void): void {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    player.src = url;
    player.onended = () => { URL.revokeObjectURL(url); onEnd?.(); };
    player.play().catch(() => onEnd?.());
  } catch {
    onEnd?.();
  }
}

// §8.2 — wake greeting. Handles both an audio response and a JSON {audio_base64}.
function playGreeting(): Promise<void> {
  return new Promise(async (resolve) => {
    try {
      const res = await fetch(API.greeting);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const j = await res.json().catch(() => ({}));
        if (j.audio_base64) { playB64(j.audio_base64, j.mime || 'audio/mpeg', resolve); return; }
        resolve();
      } else {
        const url = URL.createObjectURL(await res.blob());
        player.src = url;
        player.onended = () => { URL.revokeObjectURL(url); resolve(); };
        await player.play().catch(() => resolve());
      }
    } catch {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
function guessProvider(id: string): string {
  return /deepseek/i.test(id) ? 'cloud' : 'ollama';
}
function prettyLabel(id: string): string {
  return /^deepseek/i.test(id) ? 'DeepSeek' : id;
}

// The backend's exact shape isn't pinned down in the handoff, so accept the
// common ones: string[], {models:[...]}, or grouped {deepseek:[...],ollama:[...]}.
function normalizeModels(data: any): ModelEntry[] {
  const raw: any[] = [];
  if (Array.isArray(data)) {
    raw.push(...data);
  } else if (data && Array.isArray(data.models)) {
    raw.push(...data.models);
  } else if (data && typeof data === 'object') {
    for (const [group, val] of Object.entries(data)) {
      if (Array.isArray(val)) {
        for (const v of val) {
          raw.push(typeof v === 'string' ? { id: v, provider: group } : { provider: group, ...v });
        }
      }
    }
  }
  const out: ModelEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ id: item, label: prettyLabel(item), provider: guessProvider(item) });
    } else if (item && typeof item === 'object') {
      const id = item.id || item.name || item.model;
      if (!id) continue;
      out.push({
        id,
        label: item.label || prettyLabel(id),
        provider: item.provider || guessProvider(id),
        isDefault: item.default || item.is_default || item.isDefault,
      });
    }
  }
  return out;
}

function renderModels(entries: ModelEntry[]): void {
  const def =
    entries.find((e) => e.isDefault) ||
    entries.find((e) => /deepseek/i.test(e.id)) ||
    entries[0];
  if (def) selectedModel = def.id;

  modelList.innerHTML = '';
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'model-item' + (e.id === selectedModel ? ' selected' : '');
    const dot = document.createElement('span'); dot.className = 'dot';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = e.label;
    const sub = document.createElement('span'); sub.className = 'sub'; sub.textContent = e.provider;
    li.append(dot, name, sub);
    li.onclick = () => {
      selectedModel = e.id;
      Array.from(modelList.children).forEach((c) => c.classList.remove('selected'));
      li.classList.add('selected');
    };
    modelList.appendChild(li);
  }
}

async function loadModels(): Promise<void> {
  let entries: ModelEntry[] = [];
  try {
    const res = await fetchWithTimeout(API.models, 4000);
    if (res.ok) entries = normalizeModels(await res.json());
  } catch { /* offline / slow — fall through to fallback */ }
  if (!entries.length) entries = FALLBACK_MODELS.slice();
  renderModels(entries);
}

async function loadStatus(): Promise<void> {
  try {
    const res = await fetchWithTimeout(API.status, 3000);
    if (!res.ok) return;
    const s = await res.json();
    const bits: string[] = [];
    if (s.model) bits.push(String(s.model));
    if (s.voice || s.voice_name) bits.push('🔊 ' + (s.voice || s.voice_name));
    if (bits.length) backendInfo.textContent = bits.join(' · ');
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Shared response handling (chat + voice)
// ---------------------------------------------------------------------------
function handleResponse(data: any, fromVoice: boolean): void {
  // §6.3 — voice responses carry the STT transcript so ATI can tell
  // "STT misheard" apart from "tool didn't match".
  const transcript = data.transcript || data.heard || data.stt;
  if (fromVoice && transcript) {
    addBubble('user', transcript);
    history.push({ role: 'user', content: transcript });
  }

  const reply = data.reply ?? data.text ?? data.message ?? '';
  if (reply) {
    const metaParts: string[] = [];
    if (data.voice_name) metaParts.push('🔊 ' + data.voice_name);
    if (data.model) metaParts.push(String(data.model));
    addBubble('assistant', reply, metaParts.join(' · ') || undefined);
    history.push({ role: 'assistant', content: reply });
    trimHistory();
  } else if (!transcript) {
    addBubble('error', 'NABILA returned an empty response.');
  }

  if (data.audio_base64) {
    setAvatar('speaking', 'Speaking…');
    playB64(data.audio_base64, data.mime || 'audio/mpeg', () => setAvatar('idle'));
  } else {
    setAvatar('idle');
  }
}

// ---------------------------------------------------------------------------
// Text chat
// ---------------------------------------------------------------------------
async function sendText(): Promise<void> {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  addBubble('user', text);
  history.push({ role: 'user', content: text });
  trimHistory();

  setBusy(true);
  setAvatar('thinking', 'Thinking…');
  try {
    const res = await fetch(API.chat, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        history: history.slice(0, -1), // exclude the message we just pushed
        mode: deepToggle.checked ? 'deep' : 'fast',
        model: selectedModel,
        speak: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addBubble('error', data.error || data.detail || `Chat error (${res.status})`);
      setAvatar('idle');
      return;
    }
    handleResponse(data, false);
  } catch (e: any) {
    addBubble('error', 'Request failed: ' + (e?.message || e));
    setAvatar('idle');
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Recorder (MediaRecorder, 6s auto-stop)
// ---------------------------------------------------------------------------
let mediaRecorder: MediaRecorder | null = null;
let recStream: MediaStream | null = null;
let recChunks: BlobPart[] = [];
let recTimer: number | null = null;

function isRecording(): boolean { return !!mediaRecorder; }

async function recordOnce(maxMs = RECORD_MS): Promise<Blob | null> {
  if (mediaRecorder) return null;
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    wakeLog('mic denied');
    return null;
  }
  recChunks = [];
  mediaRecorder = new MediaRecorder(recStream);
  const mime = mediaRecorder.mimeType || 'audio/webm';
  return new Promise<Blob | null>((resolve) => {
    mediaRecorder!.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRecorder!.onstop = () => {
      const blob = recChunks.length ? new Blob(recChunks, { type: mime }) : null;
      recStream?.getTracks().forEach((t) => t.stop());
      if (recTimer) { clearTimeout(recTimer); recTimer = null; }
      mediaRecorder = null;
      recStream = null;
      resolve(blob);
    };
    mediaRecorder!.start();
    // §6.5 — MediaRecorder.start() has no duration, so add the 6s fallback stop.
    recTimer = window.setTimeout(() => stopRecording(), maxMs);
  });
}

function stopRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function sendVoice(blob: Blob): Promise<void> {
  setBusy(true);
  setAvatar('thinking', 'Thinking…');
  const fd = new FormData();
  const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : 'wav';
  fd.append(VOICE_FIELD, blob, `voice.${ext}`);
  try {
    const res = await fetch(API.voice, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addBubble('error', data.error || data.detail || `Voice error (${res.status})`);
      setAvatar('idle');
      return;
    }
    handleResponse(data, true);
  } catch (e: any) {
    addBubble('error', 'Voice request failed: ' + (e?.message || e));
    setAvatar('idle');
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Wake word
// ---------------------------------------------------------------------------
const wake = new WakeListener({
  lang: 'zh-CN',
  onDebug: (line) => wakeLog(line),
  onState: (s: WakeState) => {
    wakeDot.className = 'wake-dot' + (s === 'listening' ? ' on' : s === 'error' || s === 'unsupported' ? ' err' : '');
    wakeActive = s === 'listening';
    if (s === 'listening' && !busy) setAvatar('idle');
    if (s === 'unsupported') wakeLog('wake disabled — use the 🎤 button');
  },
  onWake: async (heard) => {
    if (busy) return;
    wakeLog('WAKE ← ' + heard);
    setAvatar('listening', "I'm here!");
    wake.pause(); // free the mic for MediaRecorder
    try {
      await playGreeting();
      setAvatar('listening', 'Listening…');
      const blob = await recordOnce(RECORD_MS);
      if (blob) await sendVoice(blob);
    } finally {
      wake.resume();
    }
  },
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
sendBtn.onclick = () => sendText();
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

micBtn.onclick = async () => {
  if (isRecording()) { stopRecording(); return; }
  if (busy) return;
  micBtn.classList.add('recording');
  setAvatar('listening', 'Listening…');
  wake.pause();
  try {
    const blob = await recordOnce(RECORD_MS);
    if (blob) await sendVoice(blob);
  } finally {
    micBtn.classList.remove('recording');
    wake.resume();
  }
};

camBtn.onclick = () => addBubble('assistant', '📷 Camera / vision lands in v0.8 (qwen3-vl:8b).');
clipBtn.onclick = () => addBubble('assistant', '📎 File attach is on the roadmap.');

resetBtn.onclick = async () => {
  history = [];
  conversation.innerHTML = '';
  setAvatar('idle');
  try { await fetch(API.reset, { method: 'POST' }); } catch { /* noop */ }
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  setAvatar('idle');
  await Promise.all([loadModels(), loadStatus()]);
  if (wake.isSupported()) {
    wake.start();
    wakeLog('listening (zh-CN)…');
  }
}

boot();

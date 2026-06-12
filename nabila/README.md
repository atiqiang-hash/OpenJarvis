# NABILA — rewritten UI (drop-in `app/frontend/`)

This is **only the UI rewrite** requested in the handoff
(`只重写 UI（保留 backend + tools.py + .env）`). It does **not** touch your
backend, `tools.py`, or `.env` — it just talks to them.

> Heads up: this lives in the **OpenJarvis** repo because that's the repo this
> session was connected to. Your real NABILA project (`/Volumes/ATI-AI/NABILA/`)
> is on your Mac and isn't reachable from the cloud container, so the rewrite
> ships here for you to copy across. See **Deploy** below.

## What changed vs v0.7.3

Built to ATI's stated UI spec (handoff §11) and Plan B (§13):

- ✅ **Model list top-left** — DeepSeek default, **green highlight = selected**.
- ✅ **NABILA avatar centered**, doesn't move (sticky orb; rings change colour
  for listening / thinking / speaking).
- ✅ **Wake debug small, left** — compact monospace log under the model panel.
- ✅ **Composer bottom bar**: 🎤 📷 📎 `[input]` `[Send]`.
- ❌ **No 3-column grid** — floating flexbox panels overlay the stage (Cursor /
  Claude.ai style), so the avatar never gets squashed.
- ✅ Model list **never sticks on "Loading…"** — 4s timeout + static fallback.

Behaviour preserved from the handoff:

- Wake word **"NABILA 同学"** (zh-CN Web Speech API) + ~30 mishear variants,
  **8s debounce lock**, **6s auto-stop recording**, pause/resume of the mic
  during capture.
- Typed input also goes through TTS (NABILA always speaks); the bubble shows the
  voice name that was used.
- DeepSeek is the default model; **Deep mode** toggle sends `mode: "deep"`.

## Run (dev)

```bash
cd app/frontend
npm install
npm run dev        # http://localhost:5555  (proxies /api -> http://localhost:8001)
```

Start your existing backend on port **8001** first (unchanged). Override the
backend URL if needed: `NABILA_API_URL=http://localhost:8001 npm run dev`.

## Deploy over your local project

```bash
# from /Volumes/ATI-AI/NABILA/
cp -R <this-repo>/nabila/app/frontend/{index.html,vite.config.ts,tsconfig.json,package.json,src} \
      app/frontend/
cd app/frontend && npm install && npm run dev
```

Your `backend/main.py`, `backend/tools.py`, and `identity/.env` stay exactly as
they are.

## Backend contract it expects (handoff §7/§8 — already implemented in v0.7.3)

| Endpoint | Method | Notes |
|---|---|---|
| `/api/models` | GET | string[] **or** `{models:[…]}` **or** `{deepseek:[…],ollama:[…]}` — all normalized. |
| `/api/status` | GET | optional; reads `model` / `voice` if present. |
| `/api/chat` | POST | body `{message, history, mode, model, speak}` → `{reply, audio_base64, voice_name, model?}`. |
| `/api/voice` | POST | multipart field **`audio`** → `{reply, audio_base64, voice_name, transcript?}`. |
| `/api/greeting` | GET | audio response **or** `{audio_base64}` — both handled. |
| `/api/reset` | POST | clears server-side conversation state. |

### Two things to check against your backend

1. **Voice upload field name.** The frontend posts the recording as
   `audio`. If `main.py` expects a different name (e.g. `file`), change the
   `VOICE_FIELD` constant at the top of `src/main.ts` (one line).
2. **Response keys.** It reads `reply` / `audio_base64` / `voice_name` /
   `transcript`, with fallbacks (`text`, `message`, `heard`, `stt`). If your
   field names differ, adjust `handleResponse()` in `src/main.ts`.

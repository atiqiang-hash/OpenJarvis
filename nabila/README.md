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

## Backend contract it targets (confirmed against `main.py`)

| Endpoint | Method | Request | Response keys read |
|---|---|---|---|
| `/api/models` | GET | — | `{ default, models:[{ id, name, type, recommended }] }` |
| `/api/status` | GET | — | `model` / `voice` (best effort) |
| `/api/chat` | POST | JSON `{ message, history, mode:"deep"\|"local", model, speak }` | `reply`, `audio_base64`, `voice_name`, `model` |
| `/api/voice` | POST | multipart `audio` + `mode` + `model` + `history`(JSON string) | **`user_text`**, `reply`, `audio_base64`, `voice_name`, `model` |
| `/api/greeting` | GET | — | audio body **or** `{ audio_base64 }` |
| `/api/reset` | POST | — | — |

- `mode` is `"deep"` when the **Deep mode** toggle is on, else `"local"`.
- Voice posts `mode` / `model` / `history` too, so speaking honours the model
  picker just like typing does.
- If any field name ever drifts, the two spots to touch are `VOICE_FIELD`
  (top of `src/main.ts`) and `handleResponse()` / `normalizeModels()`.

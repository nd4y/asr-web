# asr-web

Speech recognition that runs entirely in your browser: OpenAI **Whisper** (99 languages) and
Sber **GigaAM v3** (Russian, with punctuation and number normalization), plus **speaker
diarization** — who spoke when. Nothing is uploaded anywhere: the audio stays on your device,
the models are downloaded once and kept in the browser cache, and the site itself is plain
static files.

A fork of [whisper-web](https://github.com/xenova/whisper-web) with a second engine
([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) compiled to WebAssembly), a model
loader with mirrors and checksums, diarization, and SRT/VTT export.

## Features

- **Input**: audio or video file (drag and drop works), URL, or microphone recording. Anything
  the browser can decode: wav, mp3, m4a/aac, ogg/opus, webm, flac, mp4.
- **Engines**
  - `gigaam` — [GigaAM v3](https://github.com/salute-developers/GigaAM) CTC models via
    sherpa-onnx WebAssembly. Russian only. The default `e2e` model outputs punctuation and
    normalized numbers. Single-threaded WASM runs at roughly 0.15–0.25× real time on a laptop
    (a 7-minute call in about a minute).
  - `whisper` — [Transformers.js](https://github.com/huggingface/transformers.js) with WebGPU
    when available, WASM otherwise. tiny / base / small everywhere, large-v3-turbo on WebGPU.
- **Diarization** (optional, any engine): pyannote segmentation-3.0 + speaker embeddings
  (NeMo TitaNet small) inside the same WebAssembly module. Speakers get labels you can rename in
  place; labels go into every export.
- **Output**: segments with timestamps, click to seek the player; export TXT, SRT, VTT, JSON
  (with word timestamps for GigaAM), or copy to the clipboard.
- **Models**: downloaded from Hugging Face by default, verified against sha256 in the
  [manifest](public/models/manifest.json), stored in the browser Cache API, resumable after a
  dropped connection. Any number of mirrors can be listed, and a self-hosted install can serve
  the weights itself.
- **Offline**: a PWA; after the first visit the app and the models you used work without a
  network.

## Try it

The public build is served from GitHub Pages (see the repository's *Pages* URL). Open it, drop a
file, press **Transcribe Audio**. The first run downloads the model (320 MB for GigaAM, 100–450 MB
for Whisper, 40 MB for diarization); the next runs start instantly.

## Self-hosting

The build output is a static site. Any web server works — the only requirement is the correct
MIME type for `.wasm` (`application/wasm`).

```bash
npm ci
./wasm/build.sh                 # sherpa-onnx WebAssembly module (Docker, ~10 min once)
node wasm/esm-wrappers.mjs wasm/dist
mkdir -p public/wasm && cp wasm/dist/sherpa-onnx-asr-web.{js,wasm} wasm/dist/*.mjs public/wasm/
npm run build                   # -> dist/
```

Set `VITE_BASE=/sub/path/` if the site is served from a sub-path. `stack/docker-compose.yml`
is an nginx example with sensible cache headers.

### `config.json`

`dist/config.json` (from `public/config.json`) holds per-installation defaults and is read at
page load, so it can be edited without rebuilding:

```json
{
  "sources": ["https://models.example.org"],
  "manifest": "models/manifest.json",
  "defaults": { "engine": "gigaam", "language": "ru", "diarize": false }
}
```

- `sources` — URL prefixes tried **before** each model's upstream Hugging Face URL. A mirror
  serves files as `<prefix>/<model-id>/<file>`; `models-cache/` produced by
  `node scripts/fetch-models.mjs` has exactly that layout, so it can be uploaded to any object
  storage or copied into `dist/models/` and referenced as `"{base}models"` for an air-gapped
  install.
- `defaults` — initial settings for new visitors (engine, model ids, language, diarization).

Users can add one more mirror of their own in the settings dialog.

### Models

[`public/models/manifest.json`](public/models/manifest.json) lists every model: files, sizes,
sha256, upstream URLs pinned to a commit. To add or update a model, edit the manifest and run
`node scripts/fetch-models.mjs` — it downloads the files into `models-cache/`, fills in the
checksums and fails loudly if an upstream file changed. Two tiny models (Silero VAD, pyannote
segmentation) ship with the site under `public/models/`.

## How it works

- `src/engines/sherpa/worker.ts` — one WebAssembly module built from sherpa-onnx with the VAD,
  offline-recognizer and speaker-diarization C API exported (`wasm/`). Long audio is cut into
  chunks of at most 23.5 s at the quietest points, because GigaAM is a short-form model; with
  diarization on, the speaker turns define the chunks.
- `src/engines/whisper/worker.ts` — Transformers.js pipeline; model files are handed to the
  library through a custom `fetch`, so the shared loader (`src/models/loader.ts`) controls
  sources, checksums and caching for both engines.
- `src/engines/ranges.ts` — chunking and speaker assignment by overlap.
- ONNX Runtime binaries are copied into `public/ort/` at build time; the page never loads
  anything from a CDN.

## Known limits

- Automatic speaker counting is approximate; for a phone call pick **2** in the settings.
- Word-level timestamps are available for GigaAM only.
- Safari: WASM only, prefer the smaller models; WebGPU is Chrome/Edge (and Firefox with the
  flag) today.
- Files longer than about two hours may exhaust the tab's memory; split them.
- Everything is single-threaded WebAssembly. The build can enable threads
  (`-pthread`) for hosts that send COOP/COEP headers; GitHub Pages does not.

## Credits and licenses

MIT. Built on whisper-web (MIT), Transformers.js (Apache-2.0), sherpa-onnx (Apache-2.0),
GigaAM (MIT), Whisper (MIT), Silero VAD (MIT), pyannote segmentation-3.0 (MIT), NeMo TitaNet
(CC-BY-4.0), 3D-Speaker (Apache-2.0). ONNX exports of GigaAM v3 for sherpa-onnx by
[Smirnov75](https://huggingface.co/Smirnov75/GigaAM-v3-sherpa-onnx) and
[csukuangfj](https://huggingface.co/csukuangfj).

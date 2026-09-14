/* eslint-disable @typescript-eslint/no-explicit-any */
// Web Worker running Whisper through transformers.js. Model files are fetched by the shared
// loader (with source fallback, sha256 and the Cache API) and handed to transformers.js
// through a custom fetch, so the library never talks to the network itself.
import { env, pipeline, WhisperTextStreamer } from "@huggingface/transformers";
import { loadFiles } from "../../models/loader";
import type { ModelSpec, Segment, WorkerOut } from "../../types";

interface LoadMsg {
    type: "load";
    base: string;
    spec: ModelSpec;
    device: "wasm" | "webgpu";
    sources: string[];
}
interface TranscribeMsg {
    type: "transcribe";
    audio: Float32Array;
    language: string | null; // null = auto-detect
    task: "transcribe" | "translate";
}
type In = LoadMsg | TranscribeMsg;

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

const VIRTUAL_HOST = "https://asr-web.invalid/";
let files = new Map<string, Blob>(); // "<modelId>/<file>" -> Blob
let transcriber: any = null;
let loadedKey = "";
let loadedSpec: ModelSpec | null = null;

function configureEnv(base: string) {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    env.useCustomCache = false;
    (env as any).useWasmCache = false;
    env.remoteHost = VIRTUAL_HOST;
    env.remotePathTemplate = "{model}/";
    // ONNX Runtime binaries are served with the app, never from a CDN.
    const ortBase = new URL(`${base}ort/`, self.location.href).href;
    env.backends.onnx.wasm!.wasmPaths = ortBase;
    env.backends.onnx.wasm!.numThreads = 1;
    (env as any).fetch = async (
        input: string | URL | Request,
        init?: RequestInit,
    ) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith(VIRTUAL_HOST)) {
            const key = url.slice(VIRTUAL_HOST.length);
            const blob = files.get(key);
            if (!blob)
                return new Response(null, {
                    status: 404,
                    statusText: `not preloaded: ${key}`,
                });
            return new Response(blob, {
                status: 200,
                headers: { "content-length": String(blob.size) },
            });
        }
        return fetch(input as any, init);
    };
}

async function load(msg: LoadMsg) {
    const key = `${msg.spec.id}@${msg.device}`;
    if (loadedKey === key && transcriber) {
        post({ type: "ready", modelId: msg.spec.id });
        return;
    }
    configureEnv(msg.base);
    const variant = msg.spec.variants?.[msg.device];
    if (!variant)
        throw new Error(`${msg.spec.id} has no ${msg.device} variant`);
    const loaded = await loadFiles(
        msg.spec,
        variant.files,
        msg.sources,
        (p) => post({ type: "progress", progress: p }),
        undefined,
        new URL(msg.base, self.location.href).href,
    );
    files = new Map();
    for (const [name, blob] of loaded)
        files.set(`${msg.spec.id}/${name}`, blob);
    post({ type: "stage", stage: "init-asr" });
    if (transcriber) {
        await transcriber.dispose?.();
        transcriber = null;
    }
    transcriber = await pipeline("automatic-speech-recognition", msg.spec.id, {
        device: msg.device,
        dtype: variant.dtype as any,
        progress_callback: () => {},
    });
    loadedKey = key;
    loadedSpec = msg.spec;
    post({ type: "ready", modelId: msg.spec.id });
}

async function transcribe(msg: TranscribeMsg) {
    if (!transcriber || !loadedSpec) throw new Error("model not loaded");
    const t0 = performance.now();
    const isTurbo = loadedSpec.id.includes("large-v3");
    const chunkLength = isTurbo ? 30 : 30;
    const stride = 5;
    const timePrecision =
        transcriber.processor.feature_extractor.config.chunk_length /
        transcriber.model.config.max_source_positions;

    // Partial output: text as it is generated, per chunk.
    let chunkOffset = 0;
    let partialText = "";
    const done: Segment[] = [];
    let lastPost = 0;
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
        time_precision: timePrecision,
        skip_prompt: true,
        on_chunk_start: (x: number) => {
            chunkOffset = x;
        },
        callback_function: (text: string) => {
            partialText += text;
            const now = performance.now();
            if (now - lastPost > 250) {
                lastPost = now;
                post({
                    type: "partial",
                    segments: [
                        ...done,
                        {
                            start: chunkOffset,
                            end: chunkOffset,
                            text: partialText.trim(),
                        },
                    ],
                });
            }
        },
        on_chunk_end: () => {
            if (partialText.trim())
                done.push({
                    start: chunkOffset,
                    end: chunkOffset,
                    text: partialText.trim(),
                });
            partialText = "";
        },
    });
    post({ type: "stage", stage: "asr" });
    const out = await transcriber(msg.audio, {
        top_k: 0,
        do_sample: false,
        chunk_length_s: chunkLength,
        stride_length_s: stride,
        language: msg.language ?? undefined,
        task: msg.task,
        return_timestamps: true,
        force_full_sequences: false,
        streamer,
    });
    const chunks: { text: string; timestamp: [number, number | null] }[] =
        out.chunks ?? [];
    const duration = msg.audio.length / 16000;
    const segments: Segment[] = chunks
        .map((c) => ({
            start: c.timestamp[0] ?? 0,
            end: c.timestamp[1] ?? duration,
            text: c.text.trim(),
        }))
        .filter((s) => s.text);
    post({
        type: "complete",
        transcript: {
            engine: "whisper",
            model: loadedSpec.id,
            language: msg.language ?? undefined,
            segments,
            timings: { asr: (performance.now() - t0) / 1000 },
        },
    });
}

self.addEventListener("message", async (ev: MessageEvent<In>) => {
    const msg = ev.data;
    try {
        if (msg.type === "load") await load(msg);
        else if (msg.type === "transcribe") await transcribe(msg);
    } catch (e) {
        post({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
            stage: msg.type,
        });
    }
});

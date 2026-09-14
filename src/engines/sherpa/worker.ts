/* eslint-disable @typescript-eslint/no-explicit-any */
// Web Worker hosting the sherpa-onnx WebAssembly module: Silero VAD, GigaAM (non-streaming
// CTC recognizer) and speaker diarization. Models arrive as Blobs from the shared loader and
// are written into the module's in-memory filesystem.
import { loadFiles } from "../../models/loader";
import {
    normalizeRanges,
    rangesFromTurns,
    SAMPLE_RATE,
    type Range,
} from "../ranges";
import type { ModelSpec, Segment, Turn, Word, WorkerOut } from "../../types";

interface LoadAsrMsg {
    type: "load-asr";
    base: string;
    spec: ModelSpec;
    vad: ModelSpec;
    sources: string[];
}
interface LoadDiarMsg {
    type: "load-diar";
    base: string;
    segmentation: ModelSpec;
    embedding: ModelSpec;
    sources: string[];
}
interface DiarizeMsg {
    type: "diarize";
    audio: Float32Array;
    numSpeakers: number; // 0 = auto
    threshold?: number;
}
interface TranscribeMsg {
    type: "transcribe";
    audio: Float32Array;
    turns?: Turn[];
    wordTimestamps: boolean;
}
type In = LoadAsrMsg | LoadDiarMsg | DiarizeMsg | TranscribeMsg;

const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);
const absBase = (base: string) => new URL(base, self.location.href).href;

let Module: any = null;
let wrappers: { vad: any; asr: any; diar: any } | null = null;
let recognizer: any = null;
let recognizerModel = "";
let vadModelReady = false;
let diarizer: any = null;
let diarModels = "";

async function ensureModule(base: string) {
    if (Module) return;
    const url = (f: string) =>
        new URL(`${base}wasm/${f}`, self.location.href).href;
    const [glue, vad, asr, diar] = await Promise.all([
        import(/* @vite-ignore */ url("sherpa-onnx-asr-web.js")),
        import(/* @vite-ignore */ url("sherpa-onnx-vad.mjs")),
        import(/* @vite-ignore */ url("sherpa-onnx-asr.mjs")),
        import(/* @vite-ignore */ url("sherpa-onnx-speaker-diarization.mjs")),
    ]);
    Module = await glue.default({
        print: () => {},
        printErr: (s: string) => console.warn("[sherpa]", s),
        locateFile: (f: string) => url(f),
    });
    wrappers = { vad, asr, diar };
}

async function writeModel(name: string, blob: Blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
        Module.FS.unlink("/" + name);
    } catch {
        // did not exist
    }
    Module.FS.writeFile("/" + name, bytes);
}

async function loadAsr(msg: LoadAsrMsg) {
    await ensureModule(msg.base);
    const progress = (p: any) => post({ type: "progress", progress: p });
    if (!vadModelReady) {
        const files = await loadFiles(
            msg.vad,
            Object.keys(msg.vad.files),
            msg.sources,
            progress,
            undefined,
            absBase(msg.base),
        );
        await writeModel("silero_vad.onnx", files.get("silero_vad.onnx")!);
        vadModelReady = true;
    }
    if (recognizerModel !== msg.spec.id) {
        const names = Object.keys(msg.spec.files);
        const files = await loadFiles(
            msg.spec,
            names,
            msg.sources,
            progress,
            undefined,
            absBase(msg.base),
        );
        const modelName = names.find((n) => n.endsWith(".onnx"))!;
        const tokensName = names.find((n) => n.endsWith(".txt"))!;
        post({ type: "stage", stage: "init-asr" });
        await writeModel("asr.onnx", files.get(modelName)!);
        await writeModel("tokens.txt", files.get(tokensName)!);
        if (recognizer) {
            recognizer.free();
            recognizer = null;
        }
        recognizer = new wrappers!.asr.OfflineRecognizer(
            {
                featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
                modelConfig: {
                    nemoCtc: { model: "/asr.onnx" },
                    tokens: "/tokens.txt",
                    numThreads: 1,
                    provider: "cpu",
                    debug: 0,
                    modelType: "",
                    modelingUnit: "",
                    bpeVocab: "",
                },
                decodingMethod: "greedy_search",
                maxActivePaths: 4,
                hotwordsFile: "",
                hotwordsScore: 1.5,
                ruleFsts: "",
                ruleFars: "",
                blankPenalty: 0,
            },
            Module,
        );
        recognizerModel = msg.spec.id;
    }
    post({ type: "ready", modelId: msg.spec.id });
}

async function loadDiar(msg: LoadDiarMsg) {
    await ensureModule(msg.base);
    const key = `${msg.segmentation.id}+${msg.embedding.id}`;
    if (diarModels === key) {
        post({ type: "ready", modelId: key });
        return;
    }
    const progress = (p: any) => post({ type: "progress", progress: p });
    const seg = await loadFiles(
        msg.segmentation,
        Object.keys(msg.segmentation.files),
        msg.sources,
        progress,
        undefined,
        absBase(msg.base),
    );
    const emb = await loadFiles(
        msg.embedding,
        Object.keys(msg.embedding.files),
        msg.sources,
        progress,
        undefined,
        absBase(msg.base),
    );
    post({ type: "stage", stage: "init-diar" });
    await writeModel("segmentation.onnx", seg.values().next().value!);
    await writeModel("embedding.onnx", emb.values().next().value!);
    if (diarizer) {
        diarizer.free();
        diarizer = null;
    }
    diarizer = wrappers!.diar.createOfflineSpeakerDiarization(Module, {
        segmentation: {
            pyannote: { model: "/segmentation.onnx", windowShiftRatio: 0.25 },
            numThreads: 1,
            debug: 0,
            provider: "cpu",
        },
        embedding: {
            model: "/embedding.onnx",
            numThreads: 1,
            debug: 0,
            provider: "cpu",
        },
        clustering: { numClusters: -1, threshold: 0.5, computeConfidence: 0 },
        minDurationOn: 0.3,
        minDurationOff: 0.5,
    });
    diarModels = key;
    post({ type: "ready", modelId: key });
}

function runVad(audio: Float32Array): Range[] {
    const vad = wrappers!.vad.createVad(Module, {
        sileroVad: {
            model: "/silero_vad.onnx",
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            maxSpeechDuration: 23,
            windowSize: 512,
        },
        tenVad: {
            model: "",
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            maxSpeechDuration: 20,
            windowSize: 256,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
        bufferSizeInSeconds: 60,
    });
    const ranges: Range[] = [];
    const win = 512;
    const drain = () => {
        while (!vad.isEmpty()) {
            const s = vad.front();
            ranges.push({
                start: s.start / SAMPLE_RATE,
                end: (s.start + s.samples.length) / SAMPLE_RATE,
            });
            vad.pop();
        }
    };
    for (let i = 0; i + win <= audio.length; i += win) {
        vad.acceptWaveform(audio.subarray(i, i + win));
        drain();
    }
    vad.flush();
    drain();
    vad.free();
    return ranges;
}

/** Groups CTC tokens into words using sentencepiece "▁" markers or space tokens. */
function tokensToWords(
    tokens: string[],
    timestamps: number[],
    offset: number,
    chunkEnd: number,
): Word[] {
    const words: Word[] = [];
    let cur: { text: string; start: number; end: number } | null = null;
    const flush = () => {
        if (cur && cur.text.trim())
            words.push({
                text: cur.text.trim(),
                start: cur.start,
                end: cur.end,
            });
        cur = null;
    };
    for (let i = 0; i < tokens.length; i++) {
        const raw = tokens[i] ?? "";
        const t = offset + (timestamps[i] ?? 0);
        const next =
            i + 1 < tokens.length
                ? offset + (timestamps[i + 1] ?? timestamps[i])
                : chunkEnd;
        const startsWord = raw.startsWith("▁") || raw.startsWith(" ");
        const isSpace = raw === "▁" || raw === " " || raw === "<space>";
        if (isSpace) {
            flush();
            continue;
        }
        const piece = raw.replace(/^[▁ ]/, "");
        if (startsWord || !cur) {
            flush();
            cur = { text: piece, start: t, end: next };
        } else {
            cur.text += piece;
            cur.end = next;
        }
    }
    flush();
    return words;
}

async function transcribe(msg: TranscribeMsg) {
    if (!recognizer) throw new Error("recognizer not loaded");
    const audio = msg.audio;
    const t0 = performance.now();
    let ranges: Range[];
    if (msg.turns && msg.turns.length > 0) {
        post({ type: "stage", stage: "ranges", detail: "from diarization" });
        ranges = rangesFromTurns(audio, msg.turns);
    } else {
        post({ type: "stage", stage: "vad" });
        ranges = normalizeRanges(audio, runVad(audio));
    }
    const tVad = (performance.now() - t0) / 1000;
    post({ type: "stage", stage: "asr", detail: `${ranges.length} chunks` });
    const segments: Segment[] = [];
    const t1 = performance.now();
    let lastPost = 0;
    for (const r of ranges) {
        const a = Math.floor(r.start * SAMPLE_RATE);
        const b = Math.min(audio.length, Math.floor(r.end * SAMPLE_RATE));
        if (b - a < SAMPLE_RATE * 0.1) continue;
        const stream = recognizer.createStream();
        stream.acceptWaveform(SAMPLE_RATE, audio.subarray(a, b));
        recognizer.decode(stream);
        const res = recognizer.getResult(stream);
        stream.free();
        const text: string = (res.text ?? "").trim();
        if (!text) continue;
        const seg: Segment = {
            start: r.start,
            end: r.end,
            text,
            speaker: r.speaker,
        };
        if (
            msg.wordTimestamps &&
            Array.isArray(res.tokens) &&
            Array.isArray(res.timestamps)
        ) {
            const words = tokensToWords(
                res.tokens,
                res.timestamps,
                r.start,
                r.end,
            );
            if (words.length) {
                seg.words = words;
                seg.start = Math.min(seg.start, words[0].start);
            }
        }
        segments.push(seg);
        const now = performance.now();
        if (now - lastPost > 300) {
            lastPost = now;
            post({ type: "partial", segments: segments.slice() });
        }
    }
    const tAsr = (performance.now() - t1) / 1000;
    post({
        type: "complete",
        transcript: {
            engine: "gigaam",
            model: recognizerModel,
            language: "ru",
            segments,
            turns: msg.turns,
            timings: { vad: tVad, asr: tAsr },
        },
    });
}

async function diarize(msg: DiarizeMsg) {
    if (!diarizer) throw new Error("diarizer not loaded");
    diarizer.setConfig({
        clustering: {
            numClusters: msg.numSpeakers > 0 ? msg.numSpeakers : -1,
            threshold: msg.threshold ?? 0.85,
            computeConfidence: 0,
        },
    });
    post({ type: "stage", stage: "diarize" });
    const t0 = performance.now();
    const raw = diarizer.process(msg.audio) as {
        start: number;
        end: number;
        speaker: number;
    }[];
    // Renumber speakers by order of first appearance.
    const order = new Map<number, number>();
    const turns: Turn[] = raw
        .sort((a, b) => a.start - b.start)
        .map((t) => {
            if (!order.has(t.speaker)) order.set(t.speaker, order.size);
            return {
                start: t.start,
                end: t.end,
                speaker: order.get(t.speaker)!,
            };
        });
    post({ type: "partial", segments: [], turns });
    post({
        type: "complete",
        transcript: {
            engine: "gigaam",
            model: diarModels,
            segments: [],
            turns,
            timings: { diarize: (performance.now() - t0) / 1000 },
        },
    });
}

self.addEventListener("message", async (ev: MessageEvent<In>) => {
    const msg = ev.data;
    try {
        switch (msg.type) {
            case "load-asr":
                await loadAsr(msg);
                break;
            case "load-diar":
                await loadDiar(msg);
                break;
            case "transcribe":
                await transcribe(msg);
                break;
            case "diarize":
                await diarize(msg);
                break;
        }
    } catch (e) {
        post({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
            stage: msg.type,
        });
    }
});

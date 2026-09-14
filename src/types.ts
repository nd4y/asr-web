// Shared types for engines, models and transcripts.

export type EngineId = "whisper" | "gigaam";

export interface Word {
    start: number;
    end: number;
    text: string;
}

export interface Segment {
    start: number;
    end: number;
    text: string;
    /** Speaker index (0-based) when diarization ran. */
    speaker?: number;
    words?: Word[];
}

/** One speaker turn from diarization. */
export interface Turn {
    start: number;
    end: number;
    speaker: number;
}

export interface Transcript {
    engine: EngineId;
    model: string;
    language?: string;
    segments: Segment[];
    /** Speaker turns, present when diarization ran. */
    turns?: Turn[];
    /** Set when diarization was requested but failed; transcript is still valid. */
    diarizationError?: string;
    /** Wall-clock seconds spent per stage, for the stats line. */
    timings?: Record<string, number>;
}

/** One file of a model in the manifest. `sha256` is null when not verified. */
export interface ModelFile {
    size: number;
    sha256: string | null;
}

/** Per-device variant of a whisper model (which ONNX files and dtypes to use). */
export interface WhisperVariant {
    device: "wasm" | "webgpu";
    dtype: Record<string, string>;
    files: string[];
}

export interface ModelSpec {
    id: string;
    /** Which worker consumes the model. */
    kind: "whisper" | "gigaam" | "vad" | "diar-segmentation" | "diar-embedding";
    name: string;
    /** Languages the model handles; empty = multilingual. */
    lang: string[];
    /** Hugging Face repo the files come from, for display and for the fetch script. */
    repo: string;
    /** Fallback base URLs (with trailing slash) where `files` live under their own names. */
    upstream: string[];
    files: Record<string, ModelFile>;
    /** Whisper only: variants keyed by device. */
    variants?: Record<string, WhisperVariant>;
    /** Whisper only: the repo id transformers.js sees (config/tokenizer live here). */
    hfId?: string;
    /** Approximate download size in bytes for the UI (per variant for whisper). */
    approxSize?: number;
}

export interface Manifest {
    version: number;
    models: Record<string, ModelSpec>;
}

/** Progress of one file download. */
export interface FileProgress {
    file: string;
    loaded: number;
    total: number;
    /** Where the bytes come from: "cache" or the source URL prefix. */
    source: string;
    status: "downloading" | "verifying" | "done" | "error";
    error?: string;
}

export interface Settings {
    engine: EngineId;
    whisperModel: string;
    gigaamModel: string;
    /** Whisper source language code ("auto" = detect). */
    language: string;
    task: "transcribe" | "translate";
    diarize: boolean;
    /** 0 = auto. */
    numSpeakers: number;
    wordTimestamps: boolean;
    /** Extra model sources (URL prefixes) tried before the built-in ones. */
    extraSources: string[];
}

export interface InstallConfig {
    /** Model source prefixes, tried in order before each model's upstream URLs. */
    sources: string[];
    defaults: Partial<Settings>;
    /** Path (relative to base) of the manifest. */
    manifest: string;
}

/** Messages from workers to the main thread. */
export type WorkerOut =
    | { type: "progress"; progress: FileProgress }
    | { type: "stage"; stage: string; detail?: string }
    | { type: "ready"; modelId: string }
    | { type: "partial"; segments: Segment[]; turns?: Turn[] }
    | { type: "complete"; transcript: Transcript }
    | { type: "error"; message: string; stage?: string };

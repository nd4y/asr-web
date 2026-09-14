import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    BASE,
    effectiveSources,
    loadInstallConfig,
    loadManifest,
    readSettings,
    writeSettings,
} from "../config";
import { WorkerClient } from "../engines/client";
import { assignSpeakers } from "../engines/ranges";
import type {
    FileProgress,
    InstallConfig,
    Manifest,
    ModelSpec,
    Segment,
    Settings,
    Transcript,
    Turn,
} from "../types";

export type Status =
    | "boot"
    | "idle"
    | "loading"
    | "diarizing"
    | "transcribing"
    | "done"
    | "error";

export interface Transcriber {
    ready: boolean;
    config?: InstallConfig;
    manifest?: Manifest;
    device: "wasm" | "webgpu" | null;
    settings: Settings;
    update: (patch: Partial<Settings>) => void;
    status: Status;
    stage?: string;
    isBusy: boolean;
    progressItems: FileProgress[];
    output?: Transcript;
    error?: string;
    start: (audio: AudioBuffer | undefined) => void;
    cancel: () => void;
    onInputChange: () => void;
    speakerNames: Record<number, string>;
    renameSpeaker: (i: number, name: string) => void;
    elapsed: number;
}

function toMono(audioData: AudioBuffer): Float32Array {
    if (audioData.numberOfChannels === 2) {
        const SCALING_FACTOR = Math.sqrt(2);
        const left = audioData.getChannelData(0);
        const right = audioData.getChannelData(1);
        const audio = new Float32Array(left.length);
        for (let i = 0; i < audioData.length; ++i) {
            audio[i] = (SCALING_FACTOR * (left[i] + right[i])) / 2;
        }
        return audio;
    }
    return audioData.getChannelData(0);
}

async function detectDevice(): Promise<"wasm" | "webgpu"> {
    try {
        const gpu = (
            navigator as unknown as {
                gpu?: { requestAdapter: () => Promise<unknown> };
            }
        ).gpu;
        if (gpu && (await gpu.requestAdapter())) return "webgpu";
    } catch {
        // fall through
    }
    return "wasm";
}

export function useTranscriber(): Transcriber {
    const [config, setConfig] = useState<InstallConfig>();
    const [manifest, setManifest] = useState<Manifest>();
    const [device, setDevice] = useState<"wasm" | "webgpu" | null>(null);
    const [settings, setSettings] = useState<Settings>(() =>
        readSettings({ sources: [], defaults: {}, manifest: "" }),
    );
    const [status, setStatus] = useState<Status>("boot");
    const [stage, setStage] = useState<string>();
    const [progressItems, setProgressItems] = useState<FileProgress[]>([]);
    const [output, setOutput] = useState<Transcript>();
    const [error, setError] = useState<string>();
    const [speakerNames, setSpeakerNames] = useState<Record<number, string>>(
        {},
    );
    const [elapsed, setElapsed] = useState(0);

    const sherpa = useRef(
        new WorkerClient(
            () =>
                new Worker(
                    new URL("../engines/sherpa/worker.ts", import.meta.url),
                    { type: "module" },
                ),
        ),
    );
    const whisper = useRef(
        new WorkerClient(
            () =>
                new Worker(
                    new URL("../engines/whisper/worker.ts", import.meta.url),
                    { type: "module" },
                ),
        ),
    );
    const runId = useRef(0);
    const timer = useRef<number>();

    useEffect(() => {
        let alive = true;
        (async () => {
            const cfg = await loadInstallConfig();
            const [man, dev] = await Promise.all([
                loadManifest(cfg),
                detectDevice(),
            ]);
            if (!alive) return;
            setConfig(cfg);
            setManifest(man);
            setDevice(dev);
            setSettings(readSettings(cfg));
            setStatus("idle");
        })().catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
            setStatus("error");
        });
        return () => {
            alive = false;
        };
    }, []);

    const update = useCallback((patch: Partial<Settings>) => {
        setSettings((prev) => {
            const next = { ...prev, ...patch };
            writeSettings(next);
            return next;
        });
    }, []);

    const onProgress = useCallback((p: FileProgress) => {
        setProgressItems((prev) => {
            const i = prev.findIndex((x) => x.file === p.file);
            if (i < 0) return [...prev, p];
            const next = prev.slice();
            next[i] = p;
            return next;
        });
    }, []);

    const stopTimer = () => {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = undefined;
    };

    const start = useCallback(
        async (audioData: AudioBuffer | undefined) => {
            if (!audioData || !manifest || !config || !device) return;
            const id = ++runId.current;
            const audio = toMono(audioData);
            const sources = effectiveSources(config, settings);
            const t0 = performance.now();
            setOutput(undefined);
            setError(undefined);
            setSpeakerNames({});
            setProgressItems([]);
            setElapsed(0);
            stopTimer();
            timer.current = window.setInterval(
                () => setElapsed((performance.now() - t0) / 1000),
                500,
            );
            const guard = () => id === runId.current;
            const handlers = {
                onProgress,
                onStage: (s: string, d?: string) =>
                    guard() && setStage(d ? `${s} (${d})` : s),
            };
            try {
                let turns: Turn[] | undefined;
                const timings: Record<string, number> = {};
                if (settings.diarize) {
                    const segmentation =
                        manifest.models["pyannote-segmentation-3-int8"];
                    const embedding = manifest.models["nemo-titanet-small"];
                    if (!segmentation || !embedding)
                        throw new Error(
                            "diarization models missing from manifest",
                        );
                    setStatus("loading");
                    await sherpa.current.request(
                        {
                            type: "load-diar",
                            base: BASE,
                            segmentation,
                            embedding,
                            sources,
                        },
                        handlers,
                    );
                    if (!guard()) return;
                    setStatus("diarizing");
                    const r = await sherpa.current.request(
                        {
                            type: "diarize",
                            audio,
                            numSpeakers: settings.numSpeakers,
                        },
                        {
                            ...handlers,
                            onPartial: (_s, t) =>
                                guard() &&
                                t &&
                                setOutput({
                                    engine: settings.engine,
                                    model: "",
                                    segments: [],
                                    turns: t,
                                }),
                        },
                    );
                    if (!guard()) return;
                    turns = r?.turns;
                    Object.assign(timings, r?.timings);
                }
                setStatus("loading");
                let result: Transcript | null = null;
                if (settings.engine === "gigaam") {
                    const spec = manifest.models[settings.gigaamModel] as
                        ModelSpec | undefined;
                    const vad = manifest.models["silero-vad"];
                    if (!spec || !vad)
                        throw new Error(
                            `model ${settings.gigaamModel} missing from manifest`,
                        );
                    await sherpa.current.request(
                        { type: "load-asr", base: BASE, spec, vad, sources },
                        handlers,
                    );
                    if (!guard()) return;
                    setStatus("transcribing");
                    result = await sherpa.current.request(
                        {
                            type: "transcribe",
                            audio,
                            turns,
                            wordTimestamps: settings.wordTimestamps,
                        },
                        {
                            ...handlers,
                            onPartial: (segments: Segment[]) =>
                                guard() &&
                                setOutput({
                                    engine: "gigaam",
                                    model: spec.id,
                                    segments,
                                    turns,
                                }),
                        },
                    );
                } else {
                    const spec = manifest.models[settings.whisperModel] as
                        ModelSpec | undefined;
                    if (!spec)
                        throw new Error(
                            `model ${settings.whisperModel} missing from manifest`,
                        );
                    const dev = spec.variants?.[device]
                        ? device
                        : spec.variants?.wasm
                          ? "wasm"
                          : null;
                    if (!dev)
                        throw new Error(
                            `${spec.name} needs WebGPU, which this browser does not provide`,
                        );
                    await whisper.current.request(
                        {
                            type: "load",
                            base: BASE,
                            spec,
                            device: dev,
                            sources,
                        },
                        handlers,
                    );
                    if (!guard()) return;
                    setStatus("transcribing");
                    result = await whisper.current.request(
                        {
                            type: "transcribe",
                            audio,
                            language:
                                settings.language === "auto"
                                    ? null
                                    : settings.language,
                            task: settings.task,
                        },
                        {
                            ...handlers,
                            onPartial: (segments: Segment[]) =>
                                guard() &&
                                setOutput({
                                    engine: "whisper",
                                    model: spec.id,
                                    segments,
                                    turns,
                                }),
                        },
                    );
                    if (result && turns) {
                        result = {
                            ...result,
                            segments: assignSpeakers(result.segments, turns),
                            turns,
                        };
                    }
                }
                if (!guard() || !result) return;
                result.timings = {
                    ...timings,
                    ...result.timings,
                    total: (performance.now() - t0) / 1000,
                };
                setOutput(result);
                setStatus("done");
                setStage(undefined);
                try {
                    await navigator.storage?.persist?.();
                } catch {
                    // optional
                }
            } catch (e) {
                if (!guard()) return;
                setError(e instanceof Error ? e.message : String(e));
                setStatus("error");
                setStage(undefined);
            } finally {
                if (guard()) stopTimer();
            }
        },
        [manifest, config, device, settings, onProgress],
    );

    const cancel = useCallback(() => {
        runId.current++;
        sherpa.current.terminate();
        whisper.current.terminate();
        stopTimer();
        setStatus("idle");
        setStage(undefined);
        setProgressItems([]);
    }, []);

    const onInputChange = useCallback(() => {
        setOutput(undefined);
        setError(undefined);
        setSpeakerNames({});
        if (status === "done" || status === "error") setStatus("idle");
    }, [status]);

    const renameSpeaker = useCallback((i: number, name: string) => {
        setSpeakerNames((prev) => ({ ...prev, [i]: name }));
    }, []);

    const isBusy =
        status === "loading" ||
        status === "diarizing" ||
        status === "transcribing";

    return useMemo(
        () => ({
            ready: status !== "boot",
            config,
            manifest,
            device,
            settings,
            update,
            status,
            stage,
            isBusy,
            progressItems,
            output,
            error,
            start,
            cancel,
            onInputChange,
            speakerNames,
            renameSpeaker,
            elapsed,
        }),
        [
            config,
            manifest,
            device,
            settings,
            update,
            status,
            stage,
            isBusy,
            progressItems,
            output,
            error,
            start,
            cancel,
            onInputChange,
            speakerNames,
            renameSpeaker,
            elapsed,
        ],
    );
}

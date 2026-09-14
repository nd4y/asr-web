// Installation config (public/config.json), the model manifest and user settings.
import type { InstallConfig, Manifest, ModelSpec, Settings } from "./types";

export const BASE = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : import.meta.env.BASE_URL + "/";

export const DEFAULT_SETTINGS: Settings = {
    engine: "gigaam",
    whisperModel: "whisper-small",
    gigaamModel: "gigaam-v3-e2e-ctc-int8",
    language: "ru",
    task: "transcribe",
    diarize: false,
    numSpeakers: 0,
    wordTimestamps: false,
    extraSources: [],
};

const DEFAULT_CONFIG: InstallConfig = {
    sources: [],
    defaults: {},
    manifest: "models/manifest.json",
};

const SETTINGS_KEY = "asr-web.settings.v1";

export async function loadInstallConfig(): Promise<InstallConfig> {
    try {
        const res = await fetch(`${BASE}config.json`, { cache: "no-cache" });
        if (!res.ok) return DEFAULT_CONFIG;
        const json = (await res.json()) as Partial<InstallConfig>;
        return { ...DEFAULT_CONFIG, ...json };
    } catch {
        return DEFAULT_CONFIG;
    }
}

export async function loadManifest(config: InstallConfig): Promise<Manifest> {
    const url = /^https?:/.test(config.manifest)
        ? config.manifest
        : `${BASE}${config.manifest}`;
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest ${url}: HTTP ${res.status}`);
    return (await res.json()) as Manifest;
}

export function readSettings(config: InstallConfig): Settings {
    let stored: Partial<Settings> = {};
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) stored = JSON.parse(raw) as Partial<Settings>;
    } catch {
        stored = {};
    }
    return { ...DEFAULT_SETTINGS, ...config.defaults, ...stored };
}

export function writeSettings(s: Settings): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
        // Private mode or quota: settings live for the session only.
    }
}

/** All source prefixes to try, in order: user extras, installation, then per-model upstream (added by the loader). */
export function effectiveSources(
    config: InstallConfig,
    settings: Settings,
): string[] {
    return [...settings.extraSources, ...config.sources].filter(Boolean);
}

export function modelsOfKind(
    manifest: Manifest,
    kind: ModelSpec["kind"],
): ModelSpec[] {
    return Object.values(manifest.models).filter((m) => m.kind === kind);
}

/** Bytes a model download will take, for the given device (whisper) or overall. */
export function downloadSize(spec: ModelSpec, device?: string): number {
    if (spec.variants && device && spec.variants[device]) {
        return spec.variants[device].files.reduce(
            (a, f) => a + (spec.files[f]?.size ?? 0),
            0,
        );
    }
    return Object.values(spec.files).reduce((a, f) => a + f.size, 0);
}

export function formatBytes(n: number): string {
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
    return `${n} B`;
}

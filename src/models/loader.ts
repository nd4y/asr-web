// Model file loader: tries sources in order, resumes interrupted downloads with Range
// requests, verifies sha256 from the manifest and keeps the bytes in the Cache API.
// Works both on the main thread and inside workers.
import type { FileProgress, ModelFile, ModelSpec } from "../types";

const CACHE_NAME = "asr-web-models-v1";

export class ModelLoadError extends Error {
    constructor(
        message: string,
        public readonly file: string,
        public readonly attempts: { source: string; error: string }[],
    ) {
        super(message);
    }
}

export type ProgressFn = (p: FileProgress) => void;

function cacheKey(modelId: string, file: string, meta: ModelFile): string {
    // Synthetic same-origin URL: the Cache API only accepts http(s) requests.
    const tag = meta.sha256 ? meta.sha256.slice(0, 16) : `size-${meta.size}`;
    return `https://asr-web.cache/models/${modelId}/${file}?v=${tag}`;
}

async function openCache(): Promise<Cache | null> {
    try {
        if (typeof caches === "undefined") return null;
        return await caches.open(CACHE_NAME);
    } catch {
        return null;
    }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Candidate URLs for a file, in order of preference. `base` is the absolute URL of the app
 * (used for the `{base}` placeholder of models bundled with the site).
 */
export function candidateUrls(
    spec: ModelSpec,
    file: string,
    sources: string[],
    base = "",
): string[] {
    const expand = (u: string) => u.replace("{base}", base);
    const own = sources.map(
        (s) => `${expand(s).replace(/\/+$/, "")}/${spec.id}/${file}`,
    );
    const upstream = spec.upstream.map(
        (u) => `${expand(u).replace(/\/+$/, "")}/${file}`,
    );
    return [...own, ...upstream];
}

async function downloadFrom(
    url: string,
    meta: ModelFile,
    file: string,
    onProgress: ProgressFn,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const total = meta.size;
    const out = new Uint8Array(total);
    let loaded = 0;
    let attempt = 0;
    const source = url.slice(0, url.length - file.length);
    while (loaded < total) {
        attempt++;
        const headers: Record<string, string> = {};
        if (loaded > 0) headers.Range = `bytes=${loaded}-`;
        let res: Response;
        try {
            res = await fetch(url, { headers, signal, cache: "no-store" });
        } catch (e) {
            if (signal?.aborted) throw e;
            if (attempt >= 4) throw e;
            await new Promise((r) => setTimeout(r, 1000 * attempt));
            continue;
        }
        if (loaded > 0 && res.status === 200) {
            // Server ignored Range: start over.
            loaded = 0;
        } else if (loaded > 0 && res.status !== 206) {
            throw new Error(`HTTP ${res.status} on resume`);
        } else if (loaded === 0 && !res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        // With a compressed transfer (GitHub Pages gzips .onnx) content-length is the
        // compressed size, so the early check only applies to identity responses; the
        // final byte count and sha256 are checked either way.
        const len = Number(res.headers.get("content-length") ?? 0);
        const encoded = !!res.headers.get("content-encoding");
        if (loaded === 0 && !encoded && len && len !== total) {
            throw new Error(
                `size mismatch: expected ${total}, server reports ${len}`,
            );
        }
        if (!res.body) throw new Error("empty body");
        const reader = res.body.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (loaded + value.length > total)
                    throw new Error("server sent more bytes than expected");
                out.set(value, loaded);
                loaded += value.length;
                onProgress({
                    file,
                    loaded,
                    total,
                    source,
                    status: "downloading",
                });
            }
        } catch (e) {
            if (signal?.aborted) throw e;
            if (attempt >= 4) throw e;
            // Stream broke mid-way: loop resumes with Range from `loaded`.
            await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
    }
    if (loaded !== total)
        throw new Error(`incomplete download: ${loaded} of ${total} bytes`);
    return out;
}

/**
 * Loads one file of a model: from cache if present, otherwise from the first source
 * that works. Returns the bytes as a Blob (zero-copy for the cache hit path).
 */
export async function loadFile(
    spec: ModelSpec,
    file: string,
    sources: string[],
    onProgress: ProgressFn,
    signal?: AbortSignal,
    base = "",
): Promise<Blob> {
    const meta = spec.files[file];
    if (!meta)
        throw new ModelLoadError(
            `unknown file ${file} for ${spec.id}`,
            file,
            [],
        );
    const key = cacheKey(spec.id, file, meta);
    const cache = await openCache();
    if (cache) {
        const hit = await cache.match(key);
        if (hit) {
            const blob = await hit.blob();
            if (blob.size === meta.size) {
                onProgress({
                    file,
                    loaded: meta.size,
                    total: meta.size,
                    source: "cache",
                    status: "done",
                });
                return blob;
            }
            await cache.delete(key);
        }
    }

    const attempts: { source: string; error: string }[] = [];
    for (const url of candidateUrls(spec, file, sources, base)) {
        const source = url.slice(0, url.length - file.length);
        try {
            const bytes = await downloadFrom(
                url,
                meta,
                file,
                onProgress,
                signal,
            );
            if (meta.sha256) {
                onProgress({
                    file,
                    loaded: meta.size,
                    total: meta.size,
                    source,
                    status: "verifying",
                });
                const hex = await sha256Hex(bytes.buffer as ArrayBuffer);
                if (hex !== meta.sha256)
                    throw new Error(`sha256 mismatch (${hex.slice(0, 12)}…)`);
            }
            const blob = new Blob([bytes.buffer as ArrayBuffer], {
                type: "application/octet-stream",
            });
            if (cache) {
                try {
                    await cache.put(
                        key,
                        new Response(blob, {
                            headers: { "content-length": String(meta.size) },
                        }),
                    );
                } catch (e) {
                    // Quota exceeded or private mode: keep going without cache.
                    console.warn("model cache put failed", e);
                }
            }
            onProgress({
                file,
                loaded: meta.size,
                total: meta.size,
                source,
                status: "done",
            });
            return blob;
        } catch (e) {
            if (signal?.aborted) throw e;
            const error = e instanceof Error ? e.message : String(e);
            attempts.push({ source, error });
            onProgress({
                file,
                loaded: 0,
                total: meta.size,
                source,
                status: "error",
                error,
            });
        }
    }
    throw new ModelLoadError(
        `could not download ${file}: ` +
            attempts.map((a) => `${a.source} → ${a.error}`).join("; "),
        file,
        attempts,
    );
}

/** Loads a set of files of one model (sequentially, to keep memory and progress simple). */
export async function loadFiles(
    spec: ModelSpec,
    files: string[],
    sources: string[],
    onProgress: ProgressFn,
    signal?: AbortSignal,
    base = "",
): Promise<Map<string, Blob>> {
    const out = new Map<string, Blob>();
    for (const f of files) {
        out.set(f, await loadFile(spec, f, sources, onProgress, signal, base));
    }
    return out;
}

/** True when every file of the model is already in the cache. */
export async function isCached(
    spec: ModelSpec,
    files: string[],
): Promise<boolean> {
    const cache = await openCache();
    if (!cache) return false;
    for (const f of files) {
        const meta = spec.files[f];
        if (!meta) return false;
        const hit = await cache.match(cacheKey(spec.id, f, meta));
        if (!hit) return false;
    }
    return true;
}

export async function deleteCached(spec: ModelSpec): Promise<void> {
    const cache = await openCache();
    if (!cache) return;
    for (const [f, meta] of Object.entries(spec.files)) {
        await cache.delete(cacheKey(spec.id, f, meta));
    }
}

export async function cacheUsage(): Promise<{
    usage: number;
    quota: number;
} | null> {
    try {
        if (!navigator.storage?.estimate) return null;
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return { usage, quota };
    } catch {
        return null;
    }
}

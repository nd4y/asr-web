// Promise wrapper around an engine worker: one request in flight at a time, progress and
// partial results delivered through callbacks, `complete`/`ready` resolve, `error` rejects.
import type {
    FileProgress,
    Segment,
    Transcript,
    Turn,
    WorkerOut,
} from "../types";

export interface RequestHandlers {
    onProgress?: (p: FileProgress) => void;
    onStage?: (stage: string, detail?: string) => void;
    onPartial?: (segments: Segment[], turns?: Turn[]) => void;
}

export class WorkerClient {
    private worker: Worker | null = null;
    private pending: {
        resolve: (t: Transcript | null) => void;
        reject: (e: Error) => void;
        handlers: RequestHandlers;
    } | null = null;

    constructor(private readonly create: () => Worker) {}

    private ensure(): Worker {
        if (!this.worker) {
            this.worker = this.create();
            this.worker.addEventListener(
                "message",
                (ev: MessageEvent<WorkerOut>) => this.onMessage(ev.data),
            );
            this.worker.addEventListener("error", (ev) => {
                this.fail(new Error(ev.message || "worker crashed"));
            });
        }
        return this.worker;
    }

    private onMessage(m: WorkerOut) {
        const p = this.pending;
        if (!p) return;
        switch (m.type) {
            case "progress":
                p.handlers.onProgress?.(m.progress);
                break;
            case "stage":
                p.handlers.onStage?.(m.stage, m.detail);
                break;
            case "partial":
                p.handlers.onPartial?.(m.segments, m.turns);
                break;
            case "ready":
                this.pending = null;
                p.resolve(null);
                break;
            case "complete":
                this.pending = null;
                p.resolve(m.transcript);
                break;
            case "error":
                this.pending = null;
                p.reject(
                    new Error(m.stage ? `${m.stage}: ${m.message}` : m.message),
                );
                break;
        }
    }

    private fail(e: Error) {
        const p = this.pending;
        this.pending = null;
        p?.reject(e);
    }

    request(
        msg: unknown,
        handlers: RequestHandlers = {},
    ): Promise<Transcript | null> {
        if (this.pending) return Promise.reject(new Error("worker busy"));
        const w = this.ensure();
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, handlers };
            w.postMessage(msg);
        });
    }

    /** Kills the worker; models will be re-initialised (from cache) on the next request. */
    terminate() {
        this.worker?.terminate();
        this.worker = null;
        this.fail(new Error("cancelled"));
    }

    get alive() {
        return this.worker !== null;
    }
}

// Speech ranges for short-form recognizers (GigaAM takes up to ~25 s of audio).
// Ranges come either from diarization turns or from VAD segments; neighbouring ranges
// are bridged over short pauses and long ones are cut at the quietest point.
import type { Turn } from "../types";

export interface Range {
    start: number; // seconds
    end: number;
    speaker?: number;
}

export const SAMPLE_RATE = 16000;
/** Longest chunk handed to the recognizer, seconds. */
export const MAX_CHUNK_S = 23.5;
/** Pauses shorter than this are bridged when the speaker stays the same. */
export const BRIDGE_S = 0.8;
/** Padding added around each range so word onsets are not clipped. */
export const PAD_S = 0.25;

function rms(audio: Float32Array, from: number, to: number): number {
    let acc = 0;
    const a = Math.max(0, from);
    const b = Math.min(audio.length, to);
    for (let i = a; i < b; i++) acc += audio[i] * audio[i];
    return Math.sqrt(acc / Math.max(1, b - a));
}

/** Time of the quietest 200 ms window inside [lo, hi]. */
function quietestCut(
    audio: Float32Array,
    lo: number,
    hi: number,
    win = 0.2,
): number {
    const w = Math.floor(win * SAMPLE_RATE);
    const a = Math.floor(lo * SAMPLE_RATE);
    const b = Math.floor(hi * SAMPLE_RATE) - w;
    if (b <= a) return (lo + hi) / 2;
    let best = a;
    let bestVal = Infinity;
    const step = Math.max(1, Math.floor(w / 4));
    for (let i = a; i <= b; i += step) {
        const v = rms(audio, i, i + w);
        if (v < bestVal) {
            bestVal = v;
            best = i;
        }
    }
    return (best + w / 2) / SAMPLE_RATE;
}

/** Splits a range longer than MAX_CHUNK_S into pieces, cutting where the signal is quietest. */
export function splitLong(audio: Float32Array, r: Range): Range[] {
    const out: Range[] = [];
    let start = r.start;
    while (r.end - start > MAX_CHUNK_S) {
        // Look for a cut in the last third of the allowed window, so pieces stay large.
        const lo = start + MAX_CHUNK_S * 0.6;
        const hi = start + MAX_CHUNK_S;
        const cut = quietestCut(audio, lo, hi);
        out.push({ start, end: cut, speaker: r.speaker });
        start = cut;
    }
    out.push({ start, end: r.end, speaker: r.speaker });
    return out;
}

/** Bridges short pauses between ranges of the same speaker, then splits long ranges. */
export function normalizeRanges(audio: Float32Array, ranges: Range[]): Range[] {
    const duration = audio.length / SAMPLE_RATE;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const merged: Range[] = [];
    for (const r of sorted) {
        const last = merged[merged.length - 1];
        if (
            last &&
            last.speaker === r.speaker &&
            r.start - last.end <= BRIDGE_S &&
            r.end - last.start <= MAX_CHUNK_S
        ) {
            last.end = Math.max(last.end, r.end);
        } else {
            merged.push({ ...r });
        }
    }
    const out: Range[] = [];
    for (const r of merged) {
        for (const piece of splitLong(audio, r)) {
            out.push({
                start: Math.max(0, piece.start - PAD_S),
                end: Math.min(duration, piece.end + PAD_S),
                speaker: piece.speaker,
            });
        }
    }
    return out;
}

/** Ranges from diarization turns (speaker attached to every range). */
export function rangesFromTurns(audio: Float32Array, turns: Turn[]): Range[] {
    return normalizeRanges(
        audio,
        turns.map((t) => ({ start: t.start, end: t.end, speaker: t.speaker })),
    );
}

/** Assigns speakers to arbitrary segments by time overlap with diarization turns. */
export function assignSpeakers<T extends { start: number; end: number }>(
    segments: T[],
    turns: Turn[],
): (T & { speaker?: number })[] {
    const sorted = [...turns].sort((a, b) => a.start - b.start);
    return segments.map((s) => {
        const overlap = new Map<number, number>();
        for (const t of sorted) {
            if (t.end <= s.start) continue;
            if (t.start >= s.end) break;
            const o = Math.min(s.end, t.end) - Math.max(s.start, t.start);
            if (o > 0)
                overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
        }
        let speaker: number | undefined;
        let best = 0;
        for (const [sp, o] of overlap) {
            if (o > best) {
                best = o;
                speaker = sp;
            }
        }
        if (speaker === undefined) {
            // No overlap (e.g. diarization missed it): nearest turn by midpoint.
            const mid = (s.start + s.end) / 2;
            let dist = Infinity;
            for (const t of sorted) {
                const d =
                    mid < t.start
                        ? t.start - mid
                        : mid > t.end
                          ? mid - t.end
                          : 0;
                if (d < dist) {
                    dist = d;
                    speaker = t.speaker;
                }
            }
        }
        return { ...s, speaker };
    });
}

/** Splits whisper-style segments at speaker changes inside them (by turn boundaries). */
export function splitAtSpeakerChanges<
    T extends {
        start: number;
        end: number;
        text: string;
        words?: { start: number; end: number; text: string }[];
    },
>(segments: T[], turns: Turn[]): (T & { speaker?: number })[] {
    // Only possible when word timestamps are available; otherwise fall back to overlap.
    const out: (T & { speaker?: number })[] = [];
    for (const s of segments) {
        if (!s.words || s.words.length === 0) {
            out.push(...assignSpeakers([s], turns));
            continue;
        }
        const words = assignSpeakers(s.words, turns);
        let cur: (typeof words)[number][] = [];
        const flush = () => {
            if (cur.length === 0) return;
            out.push({
                ...s,
                start: cur[0].start,
                end: cur[cur.length - 1].end,
                text: cur.map((w) => w.text).join(" "),
                words: cur.map(({ speaker: _s, ...w }) => w),
                speaker: cur[0].speaker,
            } as T & { speaker?: number });
            cur = [];
        };
        for (const w of words) {
            if (cur.length > 0 && cur[cur.length - 1].speaker !== w.speaker)
                flush();
            cur.push(w);
        }
        flush();
    }
    return out;
}

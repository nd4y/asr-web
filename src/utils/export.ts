import type { Segment, Transcript } from "../types";

export function speakerLabel(
    i: number | undefined,
    names: Record<number, string>,
): string {
    if (i === undefined) return "";
    return names[i] ?? `Speaker ${i + 1}`;
}

function pad(n: number, w = 2): string {
    return String(n).padStart(w, "0");
}

export function formatClock(seconds: number, withMs = false): string {
    const s = Math.max(0, seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    const base =
        h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    return withMs ? `${base}.${pad(ms, 3)}` : base;
}

function srtTime(seconds: number): string {
    const s = Math.max(0, seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

function vttTime(seconds: number): string {
    return srtTime(seconds).replace(",", ".");
}

function withSpeaker(seg: Segment, names: Record<number, string>): string {
    return seg.speaker === undefined
        ? seg.text
        : `${speakerLabel(seg.speaker, names)}: ${seg.text}`;
}

/** Plain text. With speakers: one line per turn, consecutive segments of a speaker joined. */
export function toTxt(t: Transcript, names: Record<number, string>): string {
    const hasSpeakers = t.segments.some((s) => s.speaker !== undefined);
    if (!hasSpeakers)
        return (
            t.segments
                .map((s) => s.text)
                .join(" ")
                .trim() + "\n"
        );
    const lines: string[] = [];
    let cur: { speaker?: number; text: string[] } | null = null;
    for (const s of t.segments) {
        if (cur && cur.speaker === s.speaker) {
            cur.text.push(s.text);
        } else {
            if (cur)
                lines.push(
                    `${speakerLabel(cur.speaker, names)}: ${cur.text.join(" ")}`,
                );
            cur = { speaker: s.speaker, text: [s.text] };
        }
    }
    if (cur)
        lines.push(
            `${speakerLabel(cur.speaker, names)}: ${cur.text.join(" ")}`,
        );
    return lines.join("\n") + "\n";
}

export function toJson(t: Transcript, names: Record<number, string>): string {
    const speakers = Object.fromEntries(
        Array.from(
            new Set(
                t.segments
                    .map((s) => s.speaker)
                    .filter((x): x is number => x !== undefined),
            ),
        ).map((i) => [i, speakerLabel(i, names)]),
    );
    return JSON.stringify(
        {
            engine: t.engine,
            model: t.model,
            language: t.language,
            text: t.segments
                .map((s) => s.text)
                .join(" ")
                .trim(),
            segments: t.segments,
            speakers,
            turns: t.turns,
            timings: t.timings,
        },
        null,
        2,
    );
}

export function toSrt(t: Transcript, names: Record<number, string>): string {
    return (
        t.segments
            .map(
                (s, i) =>
                    `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${withSpeaker(s, names)}`,
            )
            .join("\n\n") + "\n"
    );
}

export function toVtt(t: Transcript, names: Record<number, string>): string {
    return (
        "WEBVTT\n\n" +
        t.segments
            .map(
                (s) =>
                    `${vttTime(s.start)} --> ${vttTime(s.end)}\n${withSpeaker(s, names)}`,
            )
            .join("\n\n") +
        "\n"
    );
}

export function download(name: string, content: string, mime: string) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

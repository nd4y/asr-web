import { useEffect, useRef, useState } from "react";
import type { Transcriber } from "../hooks/useTranscriber";
import {
    download,
    formatClock,
    speakerLabel,
    toJson,
    toSrt,
    toTxt,
    toVtt,
} from "../utils/export";

const SPEAKER_COLORS = [
    "bg-indigo-100 text-indigo-800",
    "bg-emerald-100 text-emerald-800",
    "bg-amber-100 text-amber-800",
    "bg-rose-100 text-rose-800",
    "bg-sky-100 text-sky-800",
    "bg-violet-100 text-violet-800",
    "bg-lime-100 text-lime-800",
    "bg-orange-100 text-orange-800",
];

function speakerClass(i: number | undefined): string {
    if (i === undefined) return "bg-slate-100 text-slate-700";
    return SPEAKER_COLORS[i % SPEAKER_COLORS.length];
}

export default function Transcript({
    transcriber,
    audioElement,
}: {
    transcriber: Transcriber;
    audioElement: HTMLAudioElement | null;
}) {
    const divRef = useRef<HTMLDivElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [editing, setEditing] = useState<number | null>(null);
    const [copied, setCopied] = useState(false);
    const output = transcriber.output;
    const names = transcriber.speakerNames;

    useEffect(() => {
        if (!audioElement) return;
        const onTime = () => setCurrentTime(audioElement.currentTime);
        audioElement.addEventListener("timeupdate", onTime);
        return () => audioElement.removeEventListener("timeupdate", onTime);
    }, [audioElement]);

    // Follow the newest segment while transcribing.
    useEffect(() => {
        if (transcriber.isBusy && divRef.current) {
            const el = divRef.current;
            el.scrollTop = el.scrollHeight;
        }
    }, [output, transcriber.isBusy]);

    if (!output) return null;
    const segments = output.segments;
    const speakers = Array.from(
        new Set(
            segments
                .map((s) => s.speaker)
                .filter((x): x is number => x !== undefined),
        ),
    ).sort((a, b) => a - b);
    const hasSpeakers = speakers.length > 0 || (output.turns?.length ?? 0) > 0;
    const duration = segments.length ? segments[segments.length - 1].end : 0;
    const talk = new Map<number, number>();
    for (const t of output.turns ?? [])
        talk.set(t.speaker, (talk.get(t.speaker) ?? 0) + (t.end - t.start));
    const totalTalk = Array.from(talk.values()).reduce((a, b) => a + b, 0) || 1;
    const stem = "transcript";
    const seek = (t: number) => {
        if (!audioElement) return;
        audioElement.currentTime = t;
        void audioElement.play();
    };

    return (
        <div
            className='w-full flex flex-col my-2 p-4 max-h-[28rem] overflow-y-auto'
            ref={divRef}
        >
            {hasSpeakers && (
                <div className='flex flex-wrap gap-2 mb-3 text-xs'>
                    {(speakers.length
                        ? speakers
                        : Array.from(talk.keys()).sort()
                    ).map((i) => (
                        <span
                            key={i}
                            className={`px-2 py-1 rounded-full ${speakerClass(i)} flex items-center gap-1`}
                        >
                            {editing === i ? (
                                <input
                                    autoFocus
                                    className='bg-white/70 rounded px-1 w-28 text-xs'
                                    defaultValue={speakerLabel(i, names)}
                                    onBlur={(e) => {
                                        transcriber.renameSpeaker(
                                            i,
                                            e.target.value.trim() ||
                                                speakerLabel(i, {}),
                                        );
                                        setEditing(null);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                            (
                                                e.target as HTMLInputElement
                                            ).blur();
                                        if (e.key === "Escape")
                                            setEditing(null);
                                    }}
                                />
                            ) : (
                                <button
                                    title='Rename'
                                    onClick={() => setEditing(i)}
                                >
                                    {speakerLabel(i, names)}
                                </button>
                            )}
                            {talk.has(i) && (
                                <span className='opacity-70'>
                                    {Math.round(
                                        (100 * (talk.get(i) ?? 0)) / totalTalk,
                                    )}
                                    %
                                </span>
                            )}
                        </span>
                    ))}
                    <span className='text-slate-400 self-center'>
                        click a name to rename
                    </span>
                </div>
            )}
            {segments.map((seg, i) => {
                const active =
                    currentTime >= seg.start && currentTime < seg.end;
                return (
                    <div
                        key={`${i}-${seg.start}`}
                        className={`w-full flex flex-row mb-2 rounded-lg p-3 shadow-sm ring-1 ring-slate-700/10 cursor-pointer ${active ? "bg-indigo-50" : "bg-white"}`}
                        onClick={() => seek(seg.start)}
                    >
                        <div className='mr-4 flex flex-col items-start shrink-0 w-16'>
                            <span className='text-xs text-slate-500 font-mono'>
                                {formatClock(seg.start)}
                            </span>
                            {seg.speaker !== undefined && (
                                <span
                                    className={`mt-1 text-[10px] px-1.5 py-0.5 rounded ${speakerClass(seg.speaker)}`}
                                >
                                    {speakerLabel(seg.speaker, names)}
                                </span>
                            )}
                        </div>
                        <div className='text-left'>{seg.text}</div>
                    </div>
                );
            })}
            {segments.length === 0 && transcriber.isBusy && (
                <p className='text-sm text-slate-500'>
                    Waiting for the first words…
                </p>
            )}
            {segments.length === 0 && !transcriber.isBusy && (
                <p className='text-sm text-slate-500'>No speech recognised.</p>
            )}
            {!transcriber.isBusy && segments.length > 0 && (
                <div className='w-full text-right mt-2 flex flex-wrap gap-2 justify-end items-center'>
                    <span className='text-xs text-slate-500 mr-auto'>
                        {output.engine}/{output.model}
                        {output.timings?.total
                            ? ` · ${output.timings.total.toFixed(1)} s for ${formatClock(duration)} of audio`
                            : ""}
                    </span>
                    <ExportButton
                        label='Copy'
                        onClick={async () => {
                            await navigator.clipboard.writeText(
                                toTxt(output, names),
                            );
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        }}
                    />
                    {copied && (
                        <span className='text-xs text-emerald-700'>copied</span>
                    )}
                    <ExportButton
                        label='TXT'
                        onClick={() =>
                            download(
                                `${stem}.txt`,
                                toTxt(output, names),
                                "text/plain",
                            )
                        }
                    />
                    <ExportButton
                        label='SRT'
                        onClick={() =>
                            download(
                                `${stem}.srt`,
                                toSrt(output, names),
                                "text/plain",
                            )
                        }
                    />
                    <ExportButton
                        label='VTT'
                        onClick={() =>
                            download(
                                `${stem}.vtt`,
                                toVtt(output, names),
                                "text/vtt",
                            )
                        }
                    />
                    <ExportButton
                        label='JSON'
                        onClick={() =>
                            download(
                                `${stem}.json`,
                                toJson(output, names),
                                "application/json",
                            )
                        }
                    />
                </div>
            )}
        </div>
    );
}

function ExportButton({
    label,
    onClick,
}: {
    label: string;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className='text-white bg-indigo-600 hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-300 font-medium rounded-lg text-sm px-4 py-2 text-center inline-flex items-center'
        >
            {label}
        </button>
    );
}

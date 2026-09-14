import React, { useCallback, useEffect, useRef, useState } from "react";
import Modal from "./modal/Modal";
import { UrlInput } from "./modal/UrlInput";
import AudioPlayer from "./AudioPlayer";
import { TranscribeButton } from "./TranscribeButton";
import { Transcriber } from "../hooks/useTranscriber";
import Progress from "./Progress";
import AudioRecorder from "./AudioRecorder";
import { SettingsPanel } from "./SettingsPanel";
import { formatBytes } from "../config";

export const SAMPLING_RATE = 16000;

export enum AudioSource {
    URL = "URL",
    FILE = "FILE",
    RECORDING = "RECORDING",
}

async function decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const audioCTX = new AudioContext({ sampleRate: SAMPLING_RATE });
    try {
        return await audioCTX.decodeAudioData(data);
    } finally {
        void audioCTX.close();
    }
}

export function AudioManager(props: {
    transcriber: Transcriber;
    onAudioElement?: (el: HTMLAudioElement | null) => void;
}) {
    const [progress, setProgress] = useState<number | undefined>(undefined);
    const [audioData, setAudioData] = useState<
        | {
              buffer: AudioBuffer;
              url: string;
              source: AudioSource;
              mimeType: string;
              name: string;
          }
        | undefined
    >(undefined);
    const [audioDownloadUrl, setAudioDownloadUrl] = useState<
        string | undefined
    >(undefined);
    const [decodeError, setDecodeError] = useState<string | undefined>();
    const [dragging, setDragging] = useState(false);

    const isAudioLoading = progress !== undefined;

    const resetAudio = () => {
        setAudioData(undefined);
        setAudioDownloadUrl(undefined);
        setDecodeError(undefined);
    };

    const setAudioFromBlob = useCallback(
        async (blob: Blob, source: AudioSource, name: string) => {
            props.transcriber.onInputChange();
            setDecodeError(undefined);
            setProgress(0);
            try {
                const arrayBuffer = await blob.arrayBuffer();
                const decoded = await decode(arrayBuffer);
                setAudioData({
                    buffer: decoded,
                    url: URL.createObjectURL(blob),
                    source,
                    mimeType: blob.type || "audio/*",
                    name,
                });
            } catch (e) {
                setAudioData(undefined);
                setDecodeError(
                    `Could not decode "${name}": ${e instanceof Error ? e.message : String(e)}. The browser did not recognise the format.`,
                );
            } finally {
                setProgress(undefined);
            }
        },
        [props.transcriber],
    );

    const downloadAudioFromUrl = async (
        requestAbortController: AbortController,
    ) => {
        if (!audioDownloadUrl) return;
        try {
            setAudioData(undefined);
            setDecodeError(undefined);
            setProgress(0);
            const res = await fetch(audioDownloadUrl, {
                signal: requestAbortController.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const total = Number(res.headers.get("content-length") ?? 0);
            const chunks: Uint8Array[] = [];
            let loaded = 0;
            const reader = res.body!.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
                if (total) setProgress(loaded / total);
            }
            let mimeType = res.headers.get("content-type") ?? "audio/wav";
            if (mimeType === "audio/wave") mimeType = "audio/wav";
            const blob = new Blob(chunks as BlobPart[], { type: mimeType });
            const name = audioDownloadUrl.split("/").pop() || "audio";
            await setAudioFromBlob(blob, AudioSource.URL, name);
        } catch (error) {
            if (!requestAbortController.signal.aborted) {
                setDecodeError(
                    `Could not load ${audioDownloadUrl}: ${error instanceof Error ? error.message : String(error)}. The server must allow cross-origin requests.`,
                );
            }
        } finally {
            setProgress(undefined);
        }
    };

    useEffect(() => {
        if (audioDownloadUrl) {
            const requestAbortController = new AbortController();
            downloadAudioFromUrl(requestAbortController);
            return () => requestAbortController.abort();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [audioDownloadUrl]);

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) {
            resetAudio();
            void setAudioFromBlob(file, AudioSource.FILE, file.name);
        }
    };

    const t = props.transcriber;
    const stageLabel: Record<string, string> = {
        loading: "Loading models",
        diarizing: "Separating speakers",
        transcribing: "Transcribing",
    };

    return (
        <>
            <div
                className={`flex flex-col justify-center items-center rounded-lg bg-white shadow-xl shadow-black/5 ring-1 ${dragging ? "ring-2 ring-indigo-500" : "ring-slate-700/10"}`}
                onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
            >
                <div className='flex flex-row space-x-2 py-2 w-full px-2'>
                    <UrlTile
                        icon={<AnchorIcon />}
                        text={"From URL"}
                        onUrlUpdate={(e) => {
                            resetAudio();
                            setAudioDownloadUrl(e);
                        }}
                    />
                    <VerticalBar />
                    <FileTile
                        icon={<FolderIcon />}
                        text={"From file"}
                        onFile={(file) => {
                            resetAudio();
                            void setAudioFromBlob(
                                file,
                                AudioSource.FILE,
                                file.name,
                            );
                        }}
                    />
                    {navigator.mediaDevices && (
                        <>
                            <VerticalBar />
                            <RecordTile
                                icon={<MicrophoneIcon />}
                                text={"Record"}
                                setAudioData={(blob) => {
                                    resetAudio();
                                    void setAudioFromBlob(
                                        blob,
                                        AudioSource.RECORDING,
                                        "recording",
                                    );
                                }}
                            />
                        </>
                    )}
                </div>
                <AudioDataBar
                    progress={isAudioLoading ? progress : +!!audioData}
                />
            </div>
            {decodeError && (
                <p className='mt-3 text-sm text-red-700 bg-red-50 rounded-lg px-4 py-2 w-full'>
                    {decodeError}
                </p>
            )}
            {audioData && (
                <>
                    <AudioPlayer
                        audioUrl={audioData.url}
                        mimeType={audioData.mimeType}
                        onElement={props.onAudioElement}
                    />
                    <p className='text-xs text-slate-500 -mt-2 mb-2 px-4 w-full text-left'>
                        {audioData.name} ·{" "}
                        {Math.round(audioData.buffer.duration)} s
                        {audioData.buffer.duration > 7200 && (
                            <span className='text-amber-700'>
                                {" "}
                                · longer than 2 hours: the browser may run out
                                of memory, consider splitting the file
                            </span>
                        )}
                    </p>

                    <div className='relative w-full flex justify-center items-center'>
                        <TranscribeButton
                            onClick={() => t.start(audioData.buffer)}
                            onCancel={t.cancel}
                            isModelLoading={t.status === "loading"}
                            isTranscribing={t.isBusy}
                            disabled={!t.ready}
                            label={
                                t.isBusy
                                    ? `${stageLabel[t.status] ?? t.status}${t.stage ? ` · ${t.stage}` : ""} · ${Math.round(t.elapsed)} s`
                                    : undefined
                            }
                        />
                        <SettingsTile
                            className='absolute right-4'
                            transcriber={t}
                            icon={<SettingsIcon />}
                        />
                    </div>
                    {t.progressItems.filter(
                        (p) => p.status !== "done" || p.source !== "cache",
                    ).length > 0 &&
                        t.status === "loading" && (
                            <div className='relative z-10 p-4 w-full'>
                                <label className='text-sm text-slate-600'>
                                    Loading model files (kept in the browser
                                    cache for next time)
                                </label>
                                {t.progressItems.map((data) => (
                                    <div key={data.file}>
                                        <Progress
                                            text={`${data.file}${data.status === "verifying" ? " · verifying" : ""}${data.status === "error" ? ` · ${data.source} failed, trying next` : ""}${data.source === "cache" ? " · cached" : ""} — ${formatBytes(data.total)}`}
                                            percentage={
                                                data.total
                                                    ? (100 * data.loaded) /
                                                      data.total
                                                    : 0
                                            }
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    {t.error && (
                        <p className='mt-3 text-sm text-red-700 bg-red-50 rounded-lg px-4 py-2 w-full'>
                            {t.error}
                        </p>
                    )}
                </>
            )}
        </>
    );
}

function SettingsTile(props: {
    icon: JSX.Element;
    className?: string;
    transcriber: Transcriber;
}) {
    const [showModal, setShowModal] = useState(false);
    return (
        <div className={props.className}>
            <Tile icon={props.icon} onClick={() => setShowModal(true)} />
            <Modal
                show={showModal}
                title={"Settings"}
                content={<SettingsPanel transcriber={props.transcriber} />}
                onClose={() => setShowModal(false)}
                onSubmit={() => {}}
            />
        </div>
    );
}

function VerticalBar() {
    return <div className='w-[1px] bg-slate-200'></div>;
}

function AudioDataBar(props: { progress: number }) {
    return <ProgressBar progress={`${Math.round(props.progress * 100)}%`} />;
}

function ProgressBar(props: { progress: string }) {
    return (
        <div className='w-full bg-gray-200 rounded-full h-1'>
            <div
                className='bg-indigo-600 h-1 rounded-full transition-all duration-100'
                style={{ width: props.progress }}
            ></div>
        </div>
    );
}

function UrlTile(props: {
    icon: JSX.Element;
    text: string;
    onUrlUpdate: (url: string) => void;
}) {
    const [showModal, setShowModal] = useState(false);
    const [url, setUrl] = useState("");
    return (
        <>
            <Tile
                icon={props.icon}
                text={props.text}
                onClick={() => setShowModal(true)}
            />
            <Modal
                show={showModal}
                title={"From URL"}
                content={
                    <>
                        {
                            "Enter the URL of the audio file. The server must allow cross-origin requests (CORS)."
                        }
                        <UrlInput
                            onChange={(e) => setUrl(e.target.value)}
                            value={url}
                        />
                    </>
                }
                onClose={() => setShowModal(false)}
                submitText={"Load"}
                submitEnabled={url.length > 0}
                onSubmit={() => {
                    props.onUrlUpdate(url);
                    setShowModal(false);
                }}
            />
        </>
    );
}

function FileTile(props: {
    icon: JSX.Element;
    text: string;
    onFile: (file: File) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                type='file'
                accept='audio/*,video/*'
                className='hidden'
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) props.onFile(f);
                    e.target.value = "";
                }}
            />
            <Tile
                icon={props.icon}
                text={props.text}
                onClick={() => input.current?.click()}
            />
        </>
    );
}

function RecordTile(props: {
    icon: JSX.Element;
    text: string;
    setAudioData: (data: Blob) => void;
}) {
    const [showModal, setShowModal] = useState(false);
    const [audioBlob, setAudioBlob] = useState<Blob>();
    return (
        <>
            <Tile
                icon={props.icon}
                text={props.text}
                onClick={() => setShowModal(true)}
            />
            <Modal
                show={showModal}
                title={"From Recording"}
                content={
                    <>
                        {"Record audio using your microphone"}
                        <AudioRecorder onRecordingComplete={setAudioBlob} />
                    </>
                }
                onClose={() => {
                    setShowModal(false);
                    setAudioBlob(undefined);
                }}
                submitText={"Load"}
                submitEnabled={audioBlob !== undefined}
                onSubmit={() => {
                    if (audioBlob) props.setAudioData(audioBlob);
                    setShowModal(false);
                    setAudioBlob(undefined);
                }}
            />
        </>
    );
}

function Tile(props: {
    icon: JSX.Element;
    text?: string;
    onClick?: () => void;
}) {
    return (
        <button
            onClick={props.onClick}
            className='flex items-center justify-center rounded-lg p-2 bg-blue text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 transition-all duration-200'
        >
            <div className='w-7 h-7'>{props.icon}</div>
            {props.text && (
                <div className='ml-2 break-text text-center text-md w-30'>
                    {props.text}
                </div>
            )}
        </button>
    );
}

function AnchorIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.5'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244'
            />
        </svg>
    );
}

function FolderIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.5'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 00-1.883 2.542l.857 6a2.25 2.25 0 002.227 1.932H19.05a2.25 2.25 0 002.227-1.932l.857-6a2.25 2.25 0 00-1.883-2.542m-16.5 0V6A2.25 2.25 0 016 3.75h3.879a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H18A2.25 2.25 0 0120.25 9v.776'
            />
        </svg>
    );
}

function SettingsIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth='1.25'
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z'
            />
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'
            />
        </svg>
    );
}

function MicrophoneIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth={1.5}
            stroke='currentColor'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z'
            />
        </svg>
    );
}

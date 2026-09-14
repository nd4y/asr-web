import { downloadSize, formatBytes, modelsOfKind } from "../config";
import type { Transcriber } from "../hooks/useTranscriber";
import { LANGUAGES } from "../utils/languages";

const selectClass =
    "mt-1 mb-3 bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block w-full p-2.5";

export function SettingsPanel({ transcriber }: { transcriber: Transcriber }) {
    const { settings, update, manifest, device } = transcriber;
    if (!manifest) return <p>Loading model catalogue…</p>;

    const gigaam = modelsOfKind(manifest, "gigaam");
    const whisper = modelsOfKind(manifest, "whisper");
    const canWebgpu = device === "webgpu";

    return (
        <div className='text-left text-sm text-gray-700'>
            <label className='font-medium'>Engine</label>
            <select
                className={selectClass}
                value={settings.engine}
                onChange={(e) =>
                    update({ engine: e.target.value as "whisper" | "gigaam" })
                }
            >
                <option value='gigaam'>
                    GigaAM v3 — Russian, punctuation, best accuracy for Russian
                </option>
                <option value='whisper'>Whisper — 99 languages</option>
            </select>

            {settings.engine === "gigaam" ? (
                <>
                    <label className='font-medium'>Model</label>
                    <select
                        className={selectClass}
                        value={settings.gigaamModel}
                        onChange={(e) =>
                            update({ gigaamModel: e.target.value })
                        }
                    >
                        {gigaam.map((m) => (
                            <option key={m.id} value={m.id}>
                                {m.name} ({formatBytes(downloadSize(m))})
                            </option>
                        ))}
                    </select>
                    <label className='flex items-center gap-2 mb-3'>
                        <input
                            type='checkbox'
                            checked={settings.wordTimestamps}
                            onChange={(e) =>
                                update({ wordTimestamps: e.target.checked })
                            }
                        />
                        Word timestamps (in JSON export)
                    </label>
                </>
            ) : (
                <>
                    <label className='font-medium'>Model</label>
                    <select
                        className={selectClass}
                        value={settings.whisperModel}
                        onChange={(e) =>
                            update({ whisperModel: e.target.value })
                        }
                    >
                        {whisper
                            .filter((m) => canWebgpu || m.variants?.wasm)
                            .map((m) => {
                                const dev =
                                    canWebgpu && m.variants?.webgpu
                                        ? "webgpu"
                                        : "wasm";
                                return (
                                    <option key={m.id} value={m.id}>
                                        {m.name} (
                                        {formatBytes(downloadSize(m, dev))},{" "}
                                        {dev})
                                    </option>
                                );
                            })}
                    </select>
                    <label className='font-medium'>Language</label>
                    <select
                        className={selectClass}
                        value={settings.language}
                        onChange={(e) => update({ language: e.target.value })}
                    >
                        <option value='auto'>Detect automatically</option>
                        {Object.entries(LANGUAGES).map(([code, name]) => (
                            <option key={code} value={code}>
                                {name}
                            </option>
                        ))}
                    </select>
                    <label className='font-medium'>Task</label>
                    <select
                        className={selectClass}
                        value={settings.task}
                        onChange={(e) =>
                            update({
                                task: e.target.value as
                                    "transcribe" | "translate",
                            })
                        }
                    >
                        <option value='transcribe'>Transcribe</option>
                        <option value='translate'>Translate to English</option>
                    </select>
                </>
            )}

            <div className='border-t border-gray-200 my-3' />
            <label className='flex items-center gap-2 font-medium'>
                <input
                    type='checkbox'
                    checked={settings.diarize}
                    onChange={(e) => update({ diarize: e.target.checked })}
                />
                Speaker diarization (who spoke when)
            </label>
            {settings.diarize && (
                <>
                    <label className='block mt-2'>Number of speakers</label>
                    <select
                        className={selectClass}
                        value={settings.numSpeakers}
                        onChange={(e) =>
                            update({ numSpeakers: Number(e.target.value) })
                        }
                    >
                        <option value={0}>Detect automatically</option>
                        {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
                    <p className='text-xs text-gray-500 -mt-2 mb-3'>
                        Phone call? Choose 2 — it is more reliable than
                        automatic detection.
                    </p>
                </>
            )}

            <div className='border-t border-gray-200 my-3' />
            <label className='font-medium'>Extra model mirror (optional)</label>
            <input
                type='url'
                className={selectClass}
                placeholder='https://models.example.org'
                value={settings.extraSources[0] ?? ""}
                onChange={(e) =>
                    update({
                        extraSources: e.target.value.trim()
                            ? [e.target.value.trim()]
                            : [],
                    })
                }
            />
            <p className='text-xs text-gray-500 -mt-2'>
                A URL prefix that mirrors the model catalogue layout (
                <code>&lt;mirror&gt;/&lt;model-id&gt;/&lt;file&gt;</code>).
                Tried before the built-in sources.
                {device && (
                    <>
                        {" "}
                        Compute device: <b>{device}</b>.
                    </>
                )}
            </p>
        </div>
    );
}

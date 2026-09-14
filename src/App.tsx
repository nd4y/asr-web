import { useState } from "react";
import { AudioManager } from "./components/AudioManager";
import Transcript from "./components/Transcript";
import { useTranscriber } from "./hooks/useTranscriber";

function App() {
    const transcriber = useTranscriber();
    const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(
        null,
    );

    return (
        <div className='flex justify-center items-center min-h-screen'>
            <div className='container flex flex-col justify-center items-center py-12'>
                <h1 className='text-5xl font-extrabold tracking-tight text-slate-900 sm:text-7xl text-center'>
                    asr-web
                </h1>
                <h2 className='mt-3 mb-5 px-4 text-center text-1xl font-semibold tracking-tight text-slate-900 sm:text-2xl'>
                    Speech recognition in your browser: Whisper and GigaAM, with
                    speaker diarization
                </h2>
                <p className='mb-5 px-4 text-center text-sm text-slate-500 max-w-xl'>
                    Audio never leaves your device. Models are downloaded once
                    and kept in the browser cache.
                </p>
                <AudioManager
                    transcriber={transcriber}
                    onAudioElement={setAudioElement}
                />
                <Transcript
                    transcriber={transcriber}
                    audioElement={audioElement}
                />
            </div>

            <div className='absolute bottom-4 text-xs text-slate-500 text-center px-4'>
                <a className='underline' href='https://github.com/nd4y/asr-web'>
                    asr-web
                </a>{" "}
                · built on{" "}
                <a
                    className='underline'
                    href='https://github.com/xenova/whisper-web'
                >
                    whisper-web
                </a>
                ,{" "}
                <a
                    className='underline'
                    href='https://github.com/huggingface/transformers.js'
                >
                    Transformers.js
                </a>
                ,{" "}
                <a
                    className='underline'
                    href='https://github.com/k2-fsa/sherpa-onnx'
                >
                    sherpa-onnx
                </a>{" "}
                and{" "}
                <a
                    className='underline'
                    href='https://github.com/salute-developers/GigaAM'
                >
                    GigaAM
                </a>
            </div>
        </div>
    );
}

export default App;

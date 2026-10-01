export async function decodeAudio(
    blob: Blob,
    name: string,
    progress: (value: number) => void,
    signal: AbortSignal,
): Promise<AudioBuffer> {
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const mp3 =
        /\.(mp[123]|mpeg)(?:\?.*)?$/i.test(name) ||
        /audio\/(mpeg|mp3)/i.test(blob.type) ||
        (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) ||
        (header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 0x06) !== 0 && ((header[1] >> 3) & 3) !== 1);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const wave =
        (header[0] === 0x52 &&
            header[1] === 0x49 &&
            header[2] === 0x46 &&
            header[3] === 0x46) ||
        (header[0] === 0x52 &&
            header[1] === 0x46 &&
            header[2] === 0x36 &&
            header[3] === 0x34);
    if (mp3 || wave) return decodeStreaming(blob, progress, signal);
    const context = new AudioContext({ sampleRate: 16000 });
    try {
        return await context.decodeAudioData(await blob.arrayBuffer());
    } finally {
        void context.close();
    }
}

function decodeStreaming(
    blob: Blob,
    progress: (value: number) => void,
    signal: AbortSignal,
): Promise<AudioBuffer> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            new URL("./decode.worker.ts", import.meta.url),
            { type: "module" },
        );
        let audio: AudioBuffer | undefined;
        let written = 0;
        const cleanup = () => {
            worker.terminate();
            signal.removeEventListener("abort", abort);
        };
        const fail = (error: Error) => {
            cleanup();
            reject(error);
        };
        const abort = () => fail(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        worker.onerror = (event) =>
            fail(new Error(event.message || "Audio decoder failed."));
        worker.onmessage = (event) => {
            const message = event.data;
            try {
                if (message.type === "progress") progress(message.value);
                else if (message.type === "size")
                    audio = new AudioBuffer({
                        length: message.length,
                        numberOfChannels: 1,
                        sampleRate: 16000,
                    });
                else if (message.type === "pcm") {
                    if (!audio || written + message.pcm.length > audio.length)
                        throw new Error("Unexpected decoded audio length.");
                    audio.getChannelData(0).set(message.pcm, written);
                    written += message.pcm.length;
                    worker.postMessage("ack");
                } else if (message.type === "error")
                    fail(new Error(message.message));
                else if (message.type === "done") {
                    if (!audio || written !== audio.length)
                        throw new Error("The decoded audio is incomplete.");
                    cleanup();
                    resolve(audio);
                }
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
            }
        };
        worker.postMessage(blob);
    });
}

import { MPEGDecoder } from "mpg123-decoder";
import { MonoResampler } from "./resampler";
import { readWaveInfo, waveChannels } from "./wave";

const BLOCK = 256 * 1024;
const scope = self as unknown as {
    onmessage: ((event: MessageEvent<Blob | string>) => void) | null;
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
let acknowledge: (() => void) | undefined;
scope.onmessage = (event) => {
    if (event.data === "ack") {
        acknowledge?.();
        acknowledge = undefined;
        return;
    }
    void decode(event.data as Blob).catch((error) =>
        scope.postMessage({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
        }),
    );
};

async function decode(blob: Blob) {
    const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (
        String.fromCharCode(...header) === "RIFF" ||
        String.fromCharCode(...header) === "RF64"
    ) {
        await decodeWave(blob);
        return;
    }
    const decoder = new MPEGDecoder();
    await decoder.ready;
    try {
        let samples = 0,
            rate = 0;
        // Count first so the final mono buffer is allocated exactly once. Both
        // passes read bounded slices; no whole-file ArrayBuffer or PCM copies.
        for (let offset = 0; offset < blob.size; offset += BLOCK) {
            const decoded = decoder.decode(
                new Uint8Array(
                    await blob.slice(offset, offset + BLOCK).arrayBuffer(),
                ),
            );
            if (decoded.errors.length)
                throw new Error(
                    `MP3 decoding failed: ${decoded.errors[0].message}`,
                );
            if (decoded.samplesDecoded) {
                if (rate && rate !== decoded.sampleRate)
                    throw new Error("MP3 sample rate changes within the file.");
                rate = decoded.sampleRate;
                samples += decoded.samplesDecoded;
            }
            scope.postMessage({
                type: "progress",
                value: 0.5 * Math.min(1, (offset + BLOCK) / blob.size),
            });
        }
        if (!samples || !rate)
            throw new Error("No decodable MP3 audio was found.");
        const length = Math.floor((samples * 16000) / rate);
        scope.postMessage({ type: "size", length });
        await decoder.reset();
        const resampler = new MonoResampler(rate);
        for (let offset = 0; offset < blob.size; offset += BLOCK) {
            const decoded = decoder.decode(
                new Uint8Array(
                    await blob.slice(offset, offset + BLOCK).arrayBuffer(),
                ),
            );
            const pcm = resampler.push(decoded.channelData);
            await send(pcm);
            scope.postMessage({
                type: "progress",
                value: 0.5 + 0.5 * Math.min(1, (offset + BLOCK) / blob.size),
            });
        }
        await send(resampler.push([], true));
        scope.postMessage({ type: "done" });
    } finally {
        decoder.free();
    }
}
async function send(pcm: Float32Array) {
    if (!pcm.length) return;
    // Backpressure prevents queued messages from retaining hours of PCM.
    const received = new Promise<void>((resolve) => {
        acknowledge = resolve;
    });
    scope.postMessage({ type: "pcm", pcm }, [pcm.buffer]);
    await received;
}
async function decodeWave(blob: Blob) {
    const info = await readWaveInfo(blob);
    const length = Math.floor(((info.size / info.align) * 16000) / info.rate);
    if (!length) throw new Error("WAV audio is empty.");
    scope.postMessage({ type: "size", length });
    const resampler = new MonoResampler(info.rate);
    const block = Math.floor(BLOCK / info.align) * info.align;
    for (let offset = 0; offset < info.size; offset += block) {
        const end = Math.min(info.size, offset + block);
        const data = await blob
            .slice(info.offset + offset, info.offset + end)
            .arrayBuffer();
        await send(resampler.push(waveChannels(data, info)));
        scope.postMessage({ type: "progress", value: end / info.size });
    }
    await send(resampler.push([], true));
    scope.postMessage({ type: "done" });
}

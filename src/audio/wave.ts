export interface WaveInfo {
    rate: number;
    channels: number;
    bits: number;
    format: number;
    align: number;
    offset: number;
    size: number;
}
const text = (view: DataView, offset: number, length: number) =>
    String.fromCharCode(...new Uint8Array(view.buffer, offset, length));
export async function readWaveInfo(blob: Blob): Promise<WaveInfo> {
    const header = new DataView(await blob.slice(0, 12).arrayBuffer());
    if (
        header.byteLength < 12 ||
        !["RIFF", "RF64"].includes(text(header, 0, 4)) ||
        text(header, 8, 4) !== "WAVE"
    )
        throw new Error("Invalid WAV header.");
    let offset = 12,
        largeSize: number | undefined,
        info: Omit<WaveInfo, "offset" | "size"> | undefined;
    while (offset + 8 <= blob.size) {
        const chunk = new DataView(
            await blob.slice(offset, offset + 8).arrayBuffer(),
        );
        const id = text(chunk, 0, 4),
            size = chunk.getUint32(4, true);
        if (id === "ds64") {
            if (size < 28) throw new Error("Invalid RF64 header.");
            const ds = new DataView(
                await blob.slice(offset + 8, offset + 36).arrayBuffer(),
            );
            largeSize = Number(ds.getBigUint64(8, true));
        }
        if (id === "fmt ") {
            if (size < 16) throw new Error("Invalid WAV format header.");
            const fmt = new DataView(
                await blob
                    .slice(offset + 8, offset + 8 + Math.min(size, 40))
                    .arrayBuffer(),
            );
            let format = fmt.getUint16(0, true);
            if (format === 0xfffe && fmt.byteLength >= 40)
                format = fmt.getUint16(24, true);
            info = {
                format,
                channels: fmt.getUint16(2, true),
                rate: fmt.getUint32(4, true),
                align: fmt.getUint16(12, true),
                bits: fmt.getUint16(14, true),
            };
        }
        if (id === "data") {
            if (!info) throw new Error("WAV data precedes its format header.");
            const dataSize = size === 0xffffffff ? largeSize : size;
            if (
                dataSize === undefined ||
                !Number.isSafeInteger(dataSize) ||
                offset + 8 + dataSize > blob.size
            )
                throw new Error("WAV audio data is truncated.");
            if (
                !(
                    info.channels >= 1 &&
                    info.channels <= 32 &&
                    info.rate >= 8000 &&
                    info.rate <= 384000
                ) ||
                !(
                    (info.format === 1 &&
                        [8, 16, 24, 32].includes(info.bits)) ||
                    (info.format === 3 && [32, 64].includes(info.bits))
                ) ||
                info.align !== (info.channels * info.bits) / 8 ||
                dataSize % info.align
            )
                throw new Error(
                    "Unsupported WAV encoding. Use PCM or IEEE float audio.",
                );
            return { ...info, offset: offset + 8, size: dataSize };
        }
        offset += 8 + size + (size % 2);
    }
    throw new Error("WAV audio data was not found.");
}
export function waveChannels(
    bytes: ArrayBuffer,
    info: WaveInfo,
): Float32Array[] {
    const view = new DataView(bytes),
        frames = bytes.byteLength / info.align;
    const channels = Array.from(
        { length: info.channels },
        () => new Float32Array(frames),
    );
    for (let i = 0; i < frames; i++)
        for (let c = 0; c < channels.length; c++) {
            const offset = i * info.align + (c * info.bits) / 8;
            let value: number;
            if (info.format === 3)
                value =
                    info.bits === 32
                        ? view.getFloat32(offset, true)
                        : view.getFloat64(offset, true);
            else if (info.bits === 8)
                value = (view.getUint8(offset) - 128) / 128;
            else if (info.bits === 16)
                value = view.getInt16(offset, true) / 32768;
            else if (info.bits === 24) {
                const v =
                    view.getUint8(offset) |
                    (view.getUint8(offset + 1) << 8) |
                    (view.getUint8(offset + 2) << 16);
                value = ((v << 8) >> 8) / 8388608;
            } else value = view.getInt32(offset, true) / 2147483648;
            channels[c][i] = Number.isFinite(value) ? value : 0;
        }
    return channels;
}

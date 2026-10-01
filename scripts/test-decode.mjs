import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import ts from "typescript";
function moduleURL(file, replacements = {}) {
    let source = readFileSync(
        new URL(`../src/audio/${file}.ts`, import.meta.url),
        "utf8",
    );
    for (const [name, url] of Object.entries(replacements))
        source = source.replace(`"./${name}"`, JSON.stringify(url));
    const js = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
        },
    }).outputText;
    return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
}
const waveURL = moduleURL("wave");
const { readWaveInfo, waveChannels } = await import(waveURL);
function wav(format, bits, samples) {
    const bytes = new ArrayBuffer(44 + (samples.length * bits) / 8),
        view = new DataView(bytes);
    const string = (at, s) =>
        [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
    string(0, "RIFF");
    view.setUint32(4, bytes.byteLength - 8, true);
    string(8, "WAVE");
    string(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, (16000 * bits) / 8, true);
    view.setUint16(32, bits / 8, true);
    view.setUint16(34, bits, true);
    string(36, "data");
    view.setUint32(40, bytes.byteLength - 44, true);
    samples.forEach((x, i) =>
        bits === 16
            ? view.setInt16(44 + i * 2, x * 32768, true)
            : view.setFloat32(44 + i * 4, x, true),
    );
    return new Blob([bytes]);
}
for (const [format, bits] of [
    [1, 16],
    [3, 32],
]) {
    const blob = wav(format, bits, [0, 0.5, -0.5]);
    const info = await readWaveInfo(blob);
    assert.deepEqual(
        Array.from(
            waveChannels(await blob.slice(info.offset).arrayBuffer(), info)[0],
        ),
        [0, 0.5, -0.5],
    );
    await assert.rejects(
        readWaveInfo(blob.slice(0, blob.size - 1)),
        /truncated/,
    );
}
const workerURL = moduleURL("decode.worker", {
    resampler: moduleURL("resampler"),
    wave: waveURL,
});
// Replace the package specifier with its file URL for the data-URL module.
const decoded = Buffer.from(workerURL.split(",")[1], "base64")
    .toString()
    .replace(
        '"mpg123-decoder"',
        JSON.stringify(import.meta.resolve("mpg123-decoder")),
    );
let resolveDone,
    rejectDone,
    count = 0,
    length = 0,
    previous = 0,
    maxBlock = 0,
    energy = 0;
globalThis.self = {
    onmessage: null,
    postMessage(message) {
        if (message.type === "size") length = message.length;
        if (message.type === "pcm") {
            count += message.pcm.length;
            maxBlock = Math.max(maxBlock, message.pcm.byteLength);
            for (let i = 0; i < message.pcm.length; i += 160)
                energy += message.pcm[i] ** 2;
            queueMicrotask(() => self.onmessage({ data: "ack" }));
        }
        if (message.type === "progress") {
            assert.ok(message.value >= previous);
            previous = message.value;
        }
        if (message.type === "error") rejectDone(new Error(message.message));
        if (message.type === "done") resolveDone();
    },
};
await import(
    `data:text/javascript;base64,${Buffer.from(decoded).toString("base64")}`
);
for (const path of process.argv.slice(2)) {
    const file = await open(path),
        { size } = await file.stat();
    count = 0;
    length = 0;
    previous = 0;
    maxBlock = 0;
    energy = 0;
    const source = {
        size,
        slice(start, end = size) {
            return {
                async arrayBuffer() {
                    const bytes = new Uint8Array(Math.min(end, size) - start);
                    const { bytesRead } = await file.read(
                        bytes,
                        0,
                        bytes.length,
                        start,
                    );
                    assert.equal(bytesRead, bytes.length);
                    return bytes.buffer;
                },
            };
        },
    };
    const started = performance.now();
    await new Promise((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
        self.onmessage({ data: source });
    });
    assert.equal(count, length);
    assert.ok(count > 0);
    assert.equal(previous, 1);
    assert.ok(energy > 0);
    assert.ok(maxBlock < 5 * 1024 * 1024);
    console.log(
        JSON.stringify({
            path,
            seconds: count / 16000,
            maxBlock,
            elapsedSeconds: (performance.now() - started) / 1000,
        }),
    );
    await file.close();
}
console.log("WAV formats, truncation and streaming decoder checks passed");

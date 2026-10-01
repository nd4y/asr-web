import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const source = readFileSync(
    new URL("../src/audio/resampler.ts", import.meta.url),
    "utf8",
);
const js = ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
    },
}).outputText;
const { MonoResampler } = await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);
for (const rate of [8000, 16000, 44100, 48000]) {
    const samples = Float32Array.from({ length: rate * 2 + 13 }, (_, i) =>
        Math.sin((2 * Math.PI * 1000 * i) / rate),
    );
    const once = new MonoResampler(rate).push([samples], true);
    const streaming = new MonoResampler(rate);
    const blocks = [];
    for (let i = 0; i < samples.length; i += 791)
        blocks.push(streaming.push([samples.subarray(i, i + 791)]));
    blocks.push(streaming.push([], true));
    const joined = new Float32Array(
        blocks.reduce((sum, part) => sum + part.length, 0),
    );
    let offset = 0;
    for (const block of blocks) {
        joined.set(block, offset);
        offset += block.length;
    }
    assert.equal(joined.length, Math.floor((samples.length * 16000) / rate));
    assert.deepEqual(
        joined,
        once,
        `block boundaries must preserve ${rate} Hz audio`,
    );
    for (let i = 100; i < joined.length - 100; i++)
        assert.ok(
            Math.abs(joined[i] - Math.sin((2 * Math.PI * 1000 * i) / 16000)) <
                0.015,
        );
}
const rate = 48000;
const high = Float32Array.from({ length: rate }, (_, i) =>
    Math.sin((2 * Math.PI * 12000 * i) / rate),
);
const filtered = new MonoResampler(rate).push([high], true);
assert.ok(
    Math.max(...filtered.subarray(100, 15000).map(Math.abs)) < 0.01,
    "suppress frequencies above the output Nyquist frequency",
);
const left = new Float32Array(48000).fill(0.5);
const right = new Float32Array(48000).fill(-0.5);
assert.ok(
    new MonoResampler(rate).push([left, right], true).every((x) => x === 0),
    "mix both stereo channels",
);
console.log(
    "resampler: continuity, duration, tone fidelity, anti-aliasing and stereo mixing passed",
);

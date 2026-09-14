// Converts the sherpa-onnx JS wrappers (plain scripts with a CommonJS export block for
// Node) into ES modules so both the Vite app and Node tooling can import them.
//   node wasm/esm-wrappers.mjs wasm/dist
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "wasm/dist");
const files = {
    "sherpa-onnx-vad.js": ["createVad", "CircularBuffer", "Vad"],
    "sherpa-onnx-asr.js": [
        "OfflineRecognizer",
        "OfflineStream",
        "createOnlineRecognizer",
    ],
    "sherpa-onnx-speaker-diarization.js": [
        "createOfflineSpeakerDiarization",
        "OfflineSpeakerDiarization",
    ],
};

for (const [name, exports] of Object.entries(files)) {
    const src = readFileSync(resolve(dir, name), "utf8");
    const cut = src.lastIndexOf("if (typeof process == 'object'");
    if (cut < 0) throw new Error(`${name}: export block not found`);
    const body = src.slice(0, cut);
    const out = body + `\nexport { ${exports.join(", ")} };\n`;
    writeFileSync(resolve(dir, name.replace(/\.js$/, ".mjs")), out);
    console.log(
        `${name} -> ${name.replace(/\.js$/, ".mjs")} (${exports.join(", ")})`,
    );
}

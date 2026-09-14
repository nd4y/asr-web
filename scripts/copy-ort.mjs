// Copies the ONNX Runtime Web binaries that transformers.js needs into public/ort/, so the
// app never loads them from a CDN. Runs before `vite dev` and `vite build`.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// onnxruntime-web does not export its package.json, so look in the usual places.
const candidates = [
    join(root, "node_modules", "onnxruntime-web", "dist"),
    join(
        root,
        "node_modules",
        "@huggingface",
        "transformers",
        "node_modules",
        "onnxruntime-web",
        "dist",
    ),
];
const dist = candidates.find((d) => existsSync(d));
if (!dist)
    throw new Error(`onnxruntime-web not found in ${candidates.join(", ")}`);
const out = join(root, "public", "ort");
mkdirSync(out, { recursive: true });

const wanted =
    /^ort-wasm-simd-threaded(\.jsep|\.asyncify|\.jspi)?\.(mjs|wasm)$/;
let n = 0;
for (const f of readdirSync(dist)) {
    if (!wanted.test(f)) continue;
    copyFileSync(join(dist, f), join(out, f));
    n++;
}
if (n === 0 || !existsSync(join(out, "ort-wasm-simd-threaded.wasm"))) {
    throw new Error(`no ONNX Runtime binaries found in ${dist}`);
}
console.log(`copied ${n} ONNX Runtime files to public/ort/`);

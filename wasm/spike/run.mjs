// Stage-0 spike: measure GigaAM v3 (CTC) and speaker diarization inside the combined
// sherpa-onnx WebAssembly module, running under Node (same V8 wasm engine as Chrome).
//
//   node wasm/spike/run.mjs --wasm wasm/dist --models ~/asr-web-models --audio file.wav \
//        [--asr e2e|ctc] [--emb eres2net|titanet] [--speakers N] [--no-diar] [--no-asr]
//
// Prints real-time factors (processing time / audio duration) and heap sizes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, arr) => {
        if (a.startsWith("--"))
            acc.push([
                a.slice(2),
                arr[i + 1]?.startsWith("--") || arr[i + 1] === undefined
                    ? true
                    : arr[i + 1],
            ]);
        return acc;
    }, []),
);
const wasmDir = resolve(args.wasm ?? "wasm/dist");
const modelsDir = resolve(
    (args.models ?? "~/asr-web-models").replace(/^~/, process.env.HOME),
);
const audioPath = resolve(args.audio);
const asrVariant = args.asr ?? "e2e";
const embVariant = args.emb ?? "eres2net";
const numSpeakers = args.speakers ? Number(args.speakers) : -1;
const shift = args.shift ? Number(args.shift) : 0.1;
const threshold = args.threshold ? Number(args.threshold) : 0.5;
const chunks = args.chunks ?? "vad";
const outFile = args.out ?? null;

function readWav(path) {
    const buf = readFileSync(path);
    if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not a WAV");
    let off = 12,
        fmt = null,
        data = null;
    while (off < buf.length) {
        const id = buf.toString("ascii", off, off + 4);
        const size = buf.readUInt32LE(off + 4);
        if (id === "fmt ")
            fmt = {
                channels: buf.readUInt16LE(off + 10),
                rate: buf.readUInt32LE(off + 12),
                bits: buf.readUInt16LE(off + 22),
            };
        if (id === "data") {
            data = buf.subarray(off + 8, off + 8 + size);
            break;
        }
        off += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error("bad WAV");
    if (fmt.channels !== 1 || fmt.rate !== 16000 || fmt.bits !== 16)
        throw new Error(`need 16 kHz mono PCM16, got ${JSON.stringify(fmt)}`);
    const n = data.length / 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
    return out;
}

const { createVad } = await import(
    pathToFileURL(resolve(wasmDir, "sherpa-onnx-vad.mjs")).href
);
const { OfflineRecognizer } = await import(
    pathToFileURL(resolve(wasmDir, "sherpa-onnx-asr.mjs")).href
);
const { createOfflineSpeakerDiarization } = await import(
    pathToFileURL(resolve(wasmDir, "sherpa-onnx-speaker-diarization.mjs")).href
);
const createSherpaOnnx = (
    await import(pathToFileURL(resolve(wasmDir, "sherpa-onnx-asr-web.js")).href)
).default;

const t0 = performance.now();
const Module = await createSherpaOnnx({
    print: () => {},
    printErr: (s) => process.stderr.write(s + "\n"),
});
const heap = () => (Module.HEAPU8.length / 1048576).toFixed(0) + " MiB";
console.log(
    `module ready in ${((performance.now() - t0) / 1000).toFixed(2)} s, heap ${heap()}`,
);

function put(name, file) {
    const bytes = readFileSync(resolve(modelsDir, file));
    Module.FS.writeFile("/" + name, bytes);
    return bytes.length;
}

const audio = readWav(audioPath);
const duration = audio.length / 16000;
console.log(`audio ${audioPath}: ${duration.toFixed(1)} s`);

const results = { audio: audioPath, duration };

let preTurns = null;
if (chunks === "diar") {
    const emb = {
        eres2net: "3dspeaker_eres2net_common.onnx",
        titanet: "nemo_titanet_small.onnx",
        base200k: "3dspeaker_eres2net_base_200k.onnx",
    }[embVariant];
    put(
        "segmentation.onnx",
        "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx",
    );
    put("embedding.onnx", emb);
    const sd0 = createOfflineSpeakerDiarization(Module, {
        segmentation: {
            pyannote: { model: "/segmentation.onnx", windowShiftRatio: shift },
            numThreads: 1,
            debug: 0,
            provider: "cpu",
        },
        embedding: {
            model: "/embedding.onnx",
            numThreads: 1,
            debug: 0,
            provider: "cpu",
        },
        clustering: {
            numClusters: numSpeakers,
            threshold,
            computeConfidence: 0,
        },
        minDurationOn: 0.3,
        minDurationOff: 0.5,
    });
    preTurns = sd0.process(audio).sort((a, b) => a.start - b.start);
    sd0.free();
    console.log(`diarization-first: ${preTurns.length} turns`);
}
if (!args["no-asr"]) {
    const variants = {
        e2e: {
            ctc: "gigaam_v3_e2e_ctc_int8.onnx",
            tokens: "gigaam_v3_e2e_ctc_tokens.txt",
        },
        "e2e-fp32": {
            ctc: "gigaam_v3_e2e_ctc.onnx",
            tokens: "gigaam_v3_e2e_ctc_tokens.txt",
        },
        ctc: {
            ctc: "gigaam_v3_ctc_int8.onnx",
            tokens: "gigaam_v3_ctc_tokens.txt",
        },
        rnnt: {
            encoder: "gigaam_v3_e2e_rnnt_encoder_int8.onnx",
            decoder: "gigaam_v3_e2e_rnnt_decoder.onnx",
            joiner: "gigaam_v3_e2e_rnnt_joint.onnx",
            tokens: "gigaam_v3_e2e_rnnt_tokens.txt",
        },
    };
    const v = variants[asrVariant];
    const model = v.ctc ?? v.encoder;
    const tokens = v.tokens;
    put("silero_vad.onnx", "silero_vad.onnx");
    if (v.ctc) put("asr.onnx", v.ctc);
    else {
        put("encoder.onnx", v.encoder);
        put("decoder.onnx", v.decoder);
        put("joiner.onnx", v.joiner);
    }
    put("tokens.txt", tokens);

    let t = performance.now();
    const vad = createVad(Module, {
        sileroVad: {
            model: "/silero_vad.onnx",
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            maxSpeechDuration: 23,
            windowSize: 512,
        },
        tenVad: {
            model: "",
            threshold: 0.5,
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            maxSpeechDuration: 20,
            windowSize: 256,
        },
        sampleRate: 16000,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
        bufferSizeInSeconds: 60,
    });
    const segments = [];
    const win = 512;
    for (let i = 0; i + win <= audio.length; i += win) {
        vad.acceptWaveform(audio.subarray(i, i + win));
        while (!vad.isEmpty()) {
            const s = vad.front();
            segments.push(s);
            vad.pop();
        }
    }
    vad.flush();
    while (!vad.isEmpty()) {
        const s = vad.front();
        segments.push(s);
        vad.pop();
    }
    if (preTurns) {
        // Ranges = speaker turns bridged like the app does (same speaker, gap <= 0.8 s, <= 23.5 s), padded 0.25 s.
        const merged = [];
        for (const t of preTurns) {
            const last = merged[merged.length - 1];
            if (
                last &&
                last.speaker === t.speaker &&
                t.start - last.end <= 0.8 &&
                t.end - last.start <= 23.5
            )
                last.end = t.end;
            else merged.push({ ...t });
        }
        segments.length = 0;
        for (const m of merged) {
            const a = Math.max(0, Math.floor((m.start - 0.25) * 16000)),
                b = Math.min(audio.length, Math.floor((m.end + 0.25) * 16000));
            segments.push({ start: a, samples: audio.subarray(a, b) });
        }
    }
    if (chunks.startsWith("bridge")) {
        const maxLen = Number(chunks.split(":")[1] ?? 20),
            bridge = Number(chunks.split(":")[2] ?? 0.8);
        const merged = [];
        for (const sg of segments) {
            const last = merged[merged.length - 1];
            const end = sg.start + sg.samples.length;
            if (
                last &&
                (sg.start - last.end) / 16000 <= bridge &&
                (end - last.start) / 16000 <= maxLen
            )
                last.end = end;
            else merged.push({ start: sg.start, end });
        }
        segments.length = 0;
        for (const m of merged)
            segments.push({
                start: m.start,
                samples: audio.subarray(m.start, m.end),
            });
    }
    const vadTime = (performance.now() - t) / 1000;
    const speech = segments.reduce((a, s) => a + s.samples.length, 0) / 16000;
    console.log(
        `VAD: ${segments.length} segments, ${speech.toFixed(1)} s speech, ${vadTime.toFixed(2)} s (RTF ${(vadTime / duration).toFixed(3)}), heap ${heap()}`,
    );

    t = performance.now();
    const rec = new OfflineRecognizer(
        {
            featConfig: { sampleRate: 16000, featureDim: 80 },
            modelConfig: {
                ...(v.ctc
                    ? { nemoCtc: { model: "/asr.onnx" } }
                    : {
                          transducer: {
                              encoder: "/encoder.onnx",
                              decoder: "/decoder.onnx",
                              joiner: "/joiner.onnx",
                          },
                      }),
                tokens: "/tokens.txt",
                numThreads: 1,
                provider: "cpu",
                debug: 0,
                modelType: v.ctc ? "" : "nemo_transducer",
                modelingUnit: "",
                bpeVocab: "",
            },
            decodingMethod: "greedy_search",
            maxActivePaths: 4,
            hotwordsFile: "",
            hotwordsScore: 1.5,
            ruleFsts: "",
            ruleFars: "",
            blankPenalty: 0,
        },
        Module,
    );
    const loadTime = (performance.now() - t) / 1000;
    console.log(
        `ASR (${model}) loaded in ${loadTime.toFixed(2)} s, heap ${heap()}`,
    );

    t = performance.now();
    const texts = [];
    let first = null;
    for (const s of segments) {
        const stream = rec.createStream();
        stream.acceptWaveform(16000, s.samples);
        rec.decode(stream);
        const r = rec.getResult(stream);
        stream.free();
        if (first === null) first = (performance.now() - t) / 1000;
        texts.push({
            start: s.start / 16000,
            end: (s.start + s.samples.length) / 16000,
            text: r.text,
            tokens: r.tokens?.length,
            ts: r.timestamps?.slice(0, 3),
        });
    }
    const asrTime = (performance.now() - t) / 1000;
    console.log(
        `ASR: ${asrTime.toFixed(2)} s for ${speech.toFixed(1)} s speech (RTF vs speech ${(asrTime / speech).toFixed(3)}, vs audio ${(asrTime / duration).toFixed(3)}), first segment ${first?.toFixed(2)} s, heap ${heap()}`,
    );
    for (const x of texts.slice(0, 6))
        console.log(`  [${x.start.toFixed(1)}-${x.end.toFixed(1)}] ${x.text}`);
    if (outFile) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(outFile, texts.map((x) => x.text).join("\n") + "\n");
        console.log(`text -> ${outFile}`);
    }
    Object.assign(results, {
        asr: {
            model,
            vadTime,
            loadTime,
            asrTime,
            speech,
            segments: segments.length,
            rtfSpeech: asrTime / speech,
            rtfAudio: asrTime / duration,
        },
    });
    rec.free();
    vad.free();
}

if (!args["no-diar"]) {
    const emb = {
        eres2net: "3dspeaker_eres2net_common.onnx",
        titanet: "nemo_titanet_small.onnx",
        base200k: "3dspeaker_eres2net_base_200k.onnx",
    }[embVariant];
    put(
        "segmentation.onnx",
        "sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx",
    );
    put("embedding.onnx", emb);
    let t = performance.now();
    const sd = createOfflineSpeakerDiarization(Module, {
        segmentation: {
            pyannote: { model: "/segmentation.onnx", windowShiftRatio: shift },
            numThreads: 1,
            debug: 0,
            provider: "cpu",
        },
        embedding: {
            model: "/embedding.onnx",
            numThreads: 1,
            debug: 0,
            provider: "cpu",
        },
        clustering: {
            numClusters: numSpeakers,
            threshold,
            computeConfidence: 0,
        },
        minDurationOn: 0.3,
        minDurationOff: 0.5,
    });
    const loadTime = (performance.now() - t) / 1000;
    console.log(
        `diarization (${emb}, shift ${shift}, threshold ${threshold}) loaded in ${loadTime.toFixed(2)} s, heap ${heap()}`,
    );
    t = performance.now();
    const turns = sd.process(audio);
    const diarTime = (performance.now() - t) / 1000;
    const speakers = new Set(turns.map((x) => x.speaker));
    console.log(
        `diarization: ${turns.length} turns, ${speakers.size} speakers, ${diarTime.toFixed(2)} s (RTF ${(diarTime / duration).toFixed(3)}), heap ${heap()}`,
    );
    for (const x of turns.slice(0, 8))
        console.log(
            `  [${x.start.toFixed(1)}-${x.end.toFixed(1)}] speaker ${x.speaker}`,
        );
    Object.assign(results, {
        diar: {
            emb,
            loadTime,
            diarTime,
            turns: turns.length,
            speakers: speakers.size,
            rtf: diarTime / duration,
        },
    });
    sd.free();
}

console.log("RESULT " + JSON.stringify(results));

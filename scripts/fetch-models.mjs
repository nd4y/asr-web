// Downloads every model file listed in public/models/manifest.json from its upstream URLs
// into models-cache/<model-id>/<file>, verifies or fills in sha256 and sizes, and writes the
// manifest back. Run after adding a model or bumping an upstream commit:
//   node scripts/fetch-models.mjs [--only <model-id>] [--cache <dir>]
// The cache directory is also the layout expected by mirrors (<mirror>/<model-id>/<file>),
// so `publish-models` can upload it as is.
import { createHash } from "node:crypto";
import {
    createWriteStream,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : def;
};
const only = opt("--only", null);
const cacheDir = opt("--cache", join(root, "models-cache"));
const manifestPath = join(root, "public", "models", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

async function sha256File(path) {
    const h = createHash("sha256");
    await pipeline(Readable.from(readFileSync(path)), h);
    return h.digest("hex");
}

async function download(url, dest) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

let changed = false;
for (const spec of Object.values(manifest.models)) {
    if (only && spec.id !== only) continue;
    // Bundled models live in public/models/<id>/; everything else comes from upstream URLs.
    const upstream = spec.upstream.filter((u) => !u.startsWith("{base}"));
    for (const [file, meta] of Object.entries(spec.files)) {
        const dest = join(cacheDir, spec.id, file);
        const bundled = join(root, "public", "models", spec.id, file);
        if (!existsSync(dest) || statSync(dest).size !== meta.size) {
            if (existsSync(bundled)) {
                mkdirSync(dirname(dest), { recursive: true });
                writeFileSync(dest, readFileSync(bundled));
            } else {
                let ok = false;
                for (const u of upstream) {
                    const url = `${u.replace(/\/+$/, "")}/${file}`;
                    try {
                        process.stdout.write(`${spec.id}/${file} <- ${url}\n`);
                        await download(url, dest);
                        ok = true;
                        break;
                    } catch (e) {
                        console.warn(`  failed: ${e.message}`);
                    }
                }
                if (!ok)
                    throw new Error(`no source worked for ${spec.id}/${file}`);
            }
        }
        const size = statSync(dest).size;
        const sha = await sha256File(dest);
        if (meta.size !== size) {
            console.log(`${spec.id}/${file}: size ${meta.size} -> ${size}`);
            meta.size = size;
            changed = true;
        }
        if (meta.sha256 && meta.sha256 !== sha) {
            throw new Error(
                `${spec.id}/${file}: sha256 mismatch — upstream changed? manifest ${meta.sha256}, file ${sha}`,
            );
        }
        if (!meta.sha256) {
            meta.sha256 = sha;
            changed = true;
            console.log(`${spec.id}/${file}: sha256 ${sha}`);
        }
    }
}

if (changed) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`manifest updated: ${manifestPath}`);
} else {
    console.log("manifest already up to date");
}

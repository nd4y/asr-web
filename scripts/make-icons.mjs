// Renders public/icon-192.png and public/icon-512.png (the PWA icons) without any image
// library: draws the waveform bars into an RGBA buffer and encodes a PNG with zlib.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const BG = [0x4f, 0x46, 0xe5];
const FG = [0xff, 0xff, 0xff];
// Bars as fractions of a 64-unit square: x, y, w, h (same as public/icon.svg).
const BARS = [
    [10, 28, 5, 8],
    [18, 20, 5, 24],
    [26, 12, 5, 40],
    [34, 18, 5, 28],
    [42, 24, 5, 16],
    [50, 29, 5, 6],
];

function crc32(buf) {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++)
        crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

function render(size) {
    const s = size / 64;
    const radius = 14 * s;
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            // Rounded-corner mask for the background.
            const cx =
                x < radius
                    ? radius - x
                    : x > size - radius
                      ? x - (size - radius)
                      : 0;
            const cy =
                y < radius
                    ? radius - y
                    : y > size - radius
                      ? y - (size - radius)
                      : 0;
            const inside = cx * cx + cy * cy <= radius * radius;
            let px = inside ? BG : [0, 0, 0];
            let alpha = inside ? 255 : 0;
            for (const [bx, by, bw, bh] of BARS) {
                const x0 = bx * s,
                    x1 = (bx + bw) * s,
                    y0 = by * s,
                    y1 = (by + bh) * s;
                const r = (bw * s) / 2;
                if (x >= x0 && x < x1 && y >= y0 && y < y1) {
                    // Round the bar ends.
                    const midx = (x0 + x1) / 2;
                    const dyTop = y0 + r - y,
                        dyBot = y - (y1 - r);
                    const dy = Math.max(0, dyTop, dyBot);
                    if ((x - midx) ** 2 + dy * dy <= r * r) {
                        px = FG;
                        alpha = 255;
                    }
                }
            }
            const o = y * (size * 4 + 1) + 1 + x * 4;
            raw[o] = px[0];
            raw[o + 1] = px[1];
            raw[o + 2] = px[2];
            raw[o + 3] = alpha;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

for (const size of [192, 512]) {
    const out = join(root, "public", `icon-${size}.png`);
    writeFileSync(out, render(size));
    console.log(`wrote ${out}`);
}

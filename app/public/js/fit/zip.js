// NdurePlan - read the .fit files inside a ZIP (Garmin Connect exports a ZIP).
// Uses the browser's built-in DecompressionStream, so no library is needed.

const MAX_TOTAL = 200 * 1024 * 1024; // refuse ZIPs that would unpack to more than 200 MB

export function isZip(u8) {
    return u8 && u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4B && u8[2] === 0x03 && u8[3] === 0x04;
}

async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser can’t open ZIP files. Unzip it first and pick the .fit file inside.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** @returns [{ name, data: Uint8Array }] for every .fit file in the archive */
export async function unzipFit(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // End of central directory: last 22+ bytes (a comment can follow it).
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
        if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This ZIP file is damaged.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    let total = 0;
    for (let n = 0; n < count; n++) {
        if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014B50) throw new Error('This ZIP file is damaged.');
        const method = dv.getUint16(p + 10, true);
        const compSize = dv.getUint32(p + 20, true);
        const size = dv.getUint32(p + 24, true);
        const nameLen = dv.getUint16(p + 28, true);
        const extraLen = dv.getUint16(p + 30, true);
        const commentLen = dv.getUint16(p + 32, true);
        const local = dv.getUint32(p + 42, true);
        const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
        p += 46 + nameLen + extraLen + commentLen;
        if (!/\.fit$/i.test(name) || name.endsWith('/')) continue;
        if (dv.getUint32(local, true) !== 0x04034B50) throw new Error('This ZIP file is damaged.');
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        const raw = u8.subarray(start, start + compSize);
        total += size;
        if (total > MAX_TOTAL) throw new Error('This ZIP is too big to read here. Unzip it and pick the .fit files.');
        let data;
        if (method === 0) data = raw.slice();
        else if (method === 8) data = await inflateRaw(raw);
        else throw new Error('This ZIP uses a compression the app can’t read. Unzip it first.');
        out.push({ name: name.split('/').pop(), data });
    }
    return out;
}

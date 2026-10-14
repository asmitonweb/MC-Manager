const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Minimal reader for Minecraft's (gzipped) NBT format; enough for level.dat.
const parseNbt = (buffer) => {
    let offset = 0;
    const readString = () => {
        const length = buffer.readUInt16BE(offset);
        offset += 2;
        const value = buffer.toString('utf8', offset, offset + length);
        offset += length;
        return value;
    };
    const read = (type) => {
        switch (type) {
            case 1: return buffer.readInt8(offset++);
            case 2: { const v = buffer.readInt16BE(offset); offset += 2; return v; }
            case 3: { const v = buffer.readInt32BE(offset); offset += 4; return v; }
            case 4: { const v = buffer.readBigInt64BE(offset); offset += 8; return v; }
            case 5: { const v = buffer.readFloatBE(offset); offset += 4; return v; }
            case 6: { const v = buffer.readDoubleBE(offset); offset += 8; return v; }
            case 7: { const n = buffer.readInt32BE(offset); offset += 4 + n; return null; }
            case 8: return readString();
            case 9: {
                const elementType = buffer.readInt8(offset++);
                const n = buffer.readInt32BE(offset);
                offset += 4;
                return Array.from({ length: n }, () => read(elementType));
            }
            case 10: {
                const compound = {};
                for (;;) {
                    const tagType = buffer.readInt8(offset++);
                    if (tagType === 0) return compound;
                    const name = readString();
                    compound[name] = read(tagType);
                }
            }
            case 11: { const n = buffer.readInt32BE(offset); offset += 4 + 4 * n; return null; }
            case 12: { const n = buffer.readInt32BE(offset); offset += 4 + 8 * n; return null; }
            default: throw new Error(`Unknown NBT tag ${type}`);
        }
    };
    const rootType = buffer.readInt8(offset++);
    readString();
    return read(rootType);
};

/** { versionName, dataVersion, levelName, modded } from a world's level.dat, or null. */
const readLevelInfo = (worldDir) => {
    try {
        const raw = fs.readFileSync(path.join(worldDir, 'level.dat'));
        const data = parseNbt(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw).Data || {};
        return {
            versionName: data.Version?.Name || null,
            dataVersion: data.DataVersion ?? data.Version?.Id ?? null,
            levelName: data.LevelName || null,
            modded: Boolean(data.WasModded),
        };
    } catch {
        return null;
    }
};

module.exports = { parseNbt, readLevelInfo };

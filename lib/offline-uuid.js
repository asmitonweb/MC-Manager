const crypto = require('crypto');

/** The UUID an offline-mode server gives a name (UUID v3 of "OfflinePlayer:<name>"). */
const offlineUuid = (name) => {
    const bytes = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

module.exports = { offlineUuid };

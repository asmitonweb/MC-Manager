const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 5 * 1024 * 1024;

// Mirrors console output into a file (rotated to .1 at 5 MB). The tray sets
// MANAGER_LOG_FILE because the manager runs without a console window.
const attachLogFile = (file) => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
        size = fs.statSync(file).size;
    } catch {
        size = 0;
    }

    const write = (level, args) => {
        const line = `[${new Date().toISOString()}] ${level === 'log' ? '' : `${level.toUpperCase()} `}${util.format(...args)}\n`;
        try {
            if (size + line.length > MAX_BYTES) {
                fs.renameSync(file, `${file}.1`);
                size = 0;
            }
            fs.appendFileSync(file, line);
            size += Buffer.byteLength(line);
        } catch {
            // Logging must never take the manager down.
        }
    };

    for (const level of ['log', 'info', 'warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => {
            original(...args);
            write(level, args);
        };
    }
};

module.exports = { attachLogFile };

const os = require('os');
const { execFile } = require('child_process');

const cpuTimes = () => os.cpus().reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    acc.idle += cpu.times.idle;
    acc.total += total;
    return acc;
}, { idle: 0, total: 0 });

// Resident memory of a process in bytes (Windows only; null elsewhere or on error).
const processMemory = (pid) => new Promise((resolve) => {
    if (!pid || process.platform !== 'win32') return resolve(null);
    execFile('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
        if (error) return resolve(null);
        const fields = stdout.trim().split('","');
        const kb = Number.parseInt((fields[4] || '').replace(/[^\d]/g, ''), 10);
        resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
});

class Metrics {
    constructor({ getMinecraftPid }) {
        this.getMinecraftPid = getMinecraftPid;
        this.previous = cpuTimes();
    }

    async sample() {
        const current = cpuTimes();
        const idle = current.idle - this.previous.idle;
        const total = current.total - this.previous.total;
        this.previous = current;

        const totalMem = os.totalmem();
        const usedMem = totalMem - os.freemem();
        const mcMemory = await processMemory(this.getMinecraftPid());

        return {
            cpu: total > 0 ? Math.round(100 * (1 - idle / total)) : 0,
            ram: Math.round((usedMem / totalMem) * 100),
            ramUsed: (usedMem / 1024 ** 3).toFixed(2),
            ramTotal: (totalMem / 1024 ** 3).toFixed(2),
            mcRamUsed: mcMemory === null ? null : (mcMemory / 1024 ** 3).toFixed(2),
        };
    }
}

module.exports = { Metrics };

const { EventEmitter } = require('events');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { writeJsonAtomic } = require('./store');

class BusyError extends Error {
    constructor(current) {
        super(`Another operation is in progress: ${current.kind}`);
        this.code = 'BUSY';
        this.status = 409;
        this.current = current;
    }
}

class OperationError extends Error {
    constructor(message, { code = 'OPERATION_FAILED', status = 400 } = {}) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const MAX_JOB_LOG_LINES = 500;
const MAX_KEPT_JOBS = 50;

const publicJob = (job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    step: job.step,
    meta: job.meta,
    result: job.result,
    error: job.error,
    log: job.log,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
});

// One mutating operation at a time. Long-running operations are tracked as jobs
// whose progress is broadcast through the 'job' event.
class Operations extends EventEmitter {
    constructor({ jobsDir } = {}) {
        super();
        this.current = null;
        this.jobs = new Map();
        this.jobsDir = jobsDir;
    }

    snapshot() {
        return this.current ? { kind: this.current.kind, jobId: this.current.jobId || null } : null;
    }

    acquire(kind, jobId = null) {
        if (this.current) throw new BusyError(this.current);
        this.current = { kind, jobId, startedAt: Date.now() };
        this.emit('change', this.snapshot());
    }

    release() {
        this.current = null;
        this.emit('change', null);
    }

    async runExclusive(kind, fn) {
        this.acquire(kind);
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    // Acquires the lock synchronously so callers get BUSY immediately, then runs
    // fn in the background. Returns the job record.
    startJob(kind, fn, meta = {}) {
        const job = {
            id: crypto.randomUUID(),
            kind,
            status: 'running',
            progress: 0,
            step: 'Starting',
            meta,
            result: null,
            error: null,
            log: [],
            startedAt: new Date().toISOString(),
            finishedAt: null,
        };
        this.acquire(kind, job.id);
        this.jobs.set(job.id, job);

        let lastEmit = 0;
        const emitUpdate = (force = false) => {
            const now = Date.now();
            if (!force && now - lastEmit < 250) return;
            lastEmit = now;
            this.emit('job', publicJob(job));
        };

        const context = {
            job,
            log: (message) => {
                job.log.push(`[${new Date().toISOString()}] ${message}`);
                if (job.log.length > MAX_JOB_LOG_LINES) job.log.splice(0, job.log.length - MAX_JOB_LOG_LINES);
                emitUpdate();
            },
            progress: (progress, step) => {
                if (typeof progress === 'number') job.progress = Math.max(0, Math.min(100, Math.round(progress)));
                if (step) {
                    job.step = step;
                    job.log.push(`[${new Date().toISOString()}] ${step}`);
                }
                emitUpdate(Boolean(step));
            },
        };

        emitUpdate(true);
        Promise.resolve()
            .then(() => fn(context))
            .then((result) => {
                job.status = 'succeeded';
                job.progress = 100;
                job.step = 'Completed';
                job.result = result === undefined ? null : result;
            })
            .catch((error) => {
                job.status = 'failed';
                job.error = { message: error.message, code: error.code || 'OPERATION_FAILED' };
                job.log.push(`[${new Date().toISOString()}] ERROR ${error.message}`);
                console.error(`Job ${kind} failed:`, error);
            })
            .finally(() => {
                job.finishedAt = new Date().toISOString();
                this.release();
                emitUpdate(true);
                this.persist(job);
                this.prune();
            });

        return publicJob(job);
    }

    getJob(id) {
        const job = this.jobs.get(id);
        return job ? publicJob(job) : null;
    }

    listJobs({ active = false } = {}) {
        return [...this.jobs.values()]
            .filter((job) => !active || job.status === 'running')
            .map(publicJob)
            .reverse();
    }

    persist(job) {
        if (!this.jobsDir) return;
        try {
            writeJsonAtomic(path.join(this.jobsDir, `${job.startedAt.replace(/[:.]/g, '-')}_${job.kind}.json`), publicJob(job));
            const files = fs.readdirSync(this.jobsDir).filter((f) => f.endsWith('.json')).sort();
            for (const file of files.slice(0, Math.max(0, files.length - MAX_KEPT_JOBS))) {
                fs.rmSync(path.join(this.jobsDir, file), { force: true });
            }
        } catch (error) {
            console.error('Failed to persist job log:', error.message);
        }
    }

    prune() {
        const finished = [...this.jobs.values()].filter((job) => job.status !== 'running');
        for (const job of finished.slice(0, Math.max(0, finished.length - MAX_KEPT_JOBS))) {
            this.jobs.delete(job.id);
        }
    }
}

module.exports = { Operations, BusyError, OperationError };

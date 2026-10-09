const test = require('node:test');
const assert = require('node:assert/strict');
const { Operations } = require('../lib/operations');

test('second mutating operation is rejected with BUSY', async () => {
    const ops = new Operations();
    let release;
    const first = ops.runExclusive('backup', () => new Promise((resolve) => { release = resolve; }));
    await assert.rejects(ops.runExclusive('start', async () => {}), (error) => error.code === 'BUSY' && error.current.kind === 'backup');
    assert.throws(() => ops.startJob('install', async () => {}), { code: 'BUSY' });
    release();
    await first;
    await ops.runExclusive('start', async () => {});
    assert.equal(ops.snapshot(), null);
});

test('jobs report progress, success and failure and release the lock', async () => {
    const ops = new Operations();
    const updates = [];
    ops.on('job', (job) => updates.push(job));

    const ok = ops.startJob('backup', async ({ progress }) => {
        progress(50, 'Halfway');
        return { file: 'x.zip' };
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ops.getJob(ok.id).status, 'succeeded');
    assert.deepEqual(ops.getJob(ok.id).result, { file: 'x.zip' });
    assert.ok(updates.some((job) => job.step === 'Halfway'));

    const bad = ops.startJob('restore', async () => { throw Object.assign(new Error('boom'), { code: 'X' }); });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ops.getJob(bad.id).status, 'failed');
    assert.deepEqual(ops.getJob(bad.id).error, { message: 'boom', code: 'X' });
    assert.equal(ops.snapshot(), null);
});

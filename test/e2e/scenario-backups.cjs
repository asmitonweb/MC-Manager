const fs = require('fs');
const path = require('path');

module.exports = async ({ api, socket, log, waitForJob, startAndCheck, stopAndCheck, runCommand, sandbox }) => {
    const { worlds } = await api('GET', '/api/worlds');
    const active = worlds.find((world) => world.active);

    // Hot backup while the server runs.
    await startAndCheck(socket);
    const hot = await waitForJob(await api('POST', '/api/backups', { worldId: active.id, note: 'hot' }));
    if (!hot.result.hot) throw new Error('expected a hot backup');
    if (!hot.log.some((line) => /save-all flush: .*Saved the game/i.test(line))) throw new Error('save-all flush did not confirm');
    const saveCheck = await runCommand(socket, 'save-on');
    log(`  hot backup ok (${hot.result.sizeBytes} bytes); save-on response: ${(saveCheck || '').split('\n')[1] || ''}`);

    // A concurrent operation is refused while one runs.
    const slow = await api('POST', '/api/backups', { worldId: active.id, note: 'busy-check' });
    let busy = false;
    try {
        await api('POST', '/api/backups', { worldId: active.id });
    } catch (error) {
        busy = /BUSY/.test(error.message);
    }
    await waitForJob(slow);
    if (!busy) throw new Error('expected BUSY for a concurrent backup');
    log('  concurrent backup refused with BUSY');

    await stopAndCheck(socket);

    // Mark the world so we can tell whether restore worked.
    const marker = path.join(sandbox, 'server', 'worlds', active.id, 'e2e-marker.txt');
    fs.writeFileSync(marker, 'after-backup');

    const restore = await waitForJob(await api('POST', `/api/backups/${hot.result.id}/restore`, { mode: 'replace' }));
    if (fs.existsSync(marker)) throw new Error('restore replace did not replace the world');
    const all = await api('GET', `/api/backups?worldId=${active.id}`);
    if (!all.some((backup) => backup.kind === 'pre-restore')) throw new Error('missing pre-restore snapshot');
    log(`  restore replace ok (${restore.result.worldId}) with pre-restore snapshot`);

    const asNew = await waitForJob(await api('POST', `/api/backups/${hot.result.id}/restore`, { mode: 'new', newName: 'Restored Copy' }));
    log(`  restore as new ok (${asNew.result.worldId})`);

    const verify = await api('POST', `/api/backups/${hot.result.id}/verify`);
    if (!verify.ok) throw new Error('verify failed');
    log('  verify ok');

    // Import the backup zip as a new world through the multipart endpoint.
    const zip = fs.readFileSync(path.join(sandbox, 'backups', 'worlds', active.id, `${hot.result.id}.zip`));
    const form = new FormData();
    form.append('name', 'Imported');
    form.append('file', new Blob([zip]), 'world.zip');
    const res = await fetch('http://127.0.0.1:3999/api/worlds/import', { method: 'POST', body: form, headers: { cookie: socket.io.opts.extraHeaders.cookie } });
    if (res.status !== 202) throw new Error(`import failed: ${res.status} ${await res.text()}`);
    const imported = await waitForJob(await res.json());
    if (!fs.existsSync(path.join(sandbox, 'server', 'worlds', imported.result.worldId, 'level.dat'))) throw new Error('import produced no level.dat');
    log(`  import ok (${imported.result.worldId})`);

    // The restored world still boots.
    await startAndCheck(socket);
    await stopAndCheck(socket);
    log('  restored world boots');
};

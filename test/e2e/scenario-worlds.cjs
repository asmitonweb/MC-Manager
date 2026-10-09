const fs = require('fs');
const path = require('path');

const levelName = (sandbox) => /level-name=(.*)/.exec(fs.readFileSync(path.join(sandbox, 'server', 'server.properties'), 'utf8'))[1].trim();

module.exports = async ({ api, socket, log, waitForJob, startAndCheck, stopAndCheck, sandbox }) => {
    const before = await api('GET', '/api/worlds');
    const original = before.worlds.find((world) => world.active);
    if (!original) throw new Error('No active world after install');

    const created = await api('POST', '/api/worlds', { name: 'Second World', levelType: 'flat', setActive: true });
    if (levelName(sandbox) !== `worlds/${created.id}`) throw new Error('level-name not switched');
    log(`  created and activated ${created.id}`);

    await startAndCheck(socket);
    await stopAndCheck(socket);
    if (!fs.existsSync(path.join(sandbox, 'server', 'worlds', created.id, 'level.dat'))) throw new Error('new world not generated');
    log('  second world generated');

    await api('POST', `/api/worlds/${original.id}/activate`);
    if (levelName(sandbox) !== `worlds/${original.id}`) throw new Error('switch back failed');

    const dup = await waitForJob(await api('POST', `/api/worlds/${created.id}/duplicate`, { name: 'Copy' }));
    log(`  duplicated into ${dup.result.worldId}`);

    await waitForJob(await api('DELETE', `/api/worlds/${dup.result.worldId}?confirm=${dup.result.worldId}`));
    const after = await api('GET', '/api/worlds');
    if (after.worlds.some((world) => world.id === dup.result.worldId)) throw new Error('delete failed');
    const backups = await api('GET', `/api/backups?worldId=${dup.result.worldId}`);
    if (!backups.some((backup) => backup.kind === 'pre-delete')) throw new Error('missing pre-delete backup');
    log('  deleted duplicate with pre-delete backup');

    let refused = false;
    try {
        await api('DELETE', `/api/worlds/${original.id}?confirm=${original.id}`);
    } catch {
        refused = true;
    }
    if (!refused) throw new Error('deleting the active world was allowed');
    log('  active world delete refused');
};

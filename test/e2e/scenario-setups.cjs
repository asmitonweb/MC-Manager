// Run with: node test/e2e/e2e.cjs <dir> fabric 26.2 setups
module.exports = async ({ api, socket, log, waitForJob, startAndCheck, stopAndCheck }) => {
    const { worlds } = await api('GET', '/api/worlds');
    const original = worlds.find((world) => world.active);

    // Generate the 26.2 world, then add a 26.3 setup next to it.
    await startAndCheck(socket);
    await stopAndCheck(socket);
    const versions = await api('GET', '/api/server/install/versions?loader=fabric');
    const latest = versions[0].id;
    log(`  adding a Fabric ${latest} setup`);
    await waitForJob(await api('POST', '/api/server/install', {
        loader: 'fabric', minecraftVersion: latest, memory: { min: '1G', max: '2G' }, acceptEula: true, newSetup: true,
    }));
    const { setups } = await api('GET', '/api/setups');
    if (setups.length !== 2) throw new Error(`expected 2 setups, got ${setups.length}`);
    const newSetup = setups.find((setup) => setup.active);
    const oldSetup = setups.find((setup) => !setup.active);
    log(`  setups: ${setups.map((s) => `${s.id}${s.active ? '*' : ''}`).join(', ')}`);

    // Moving the 26.2 world to the newer setup requires confirmation, then switches the server.
    let asked = false;
    try {
        await api('PATCH', `/api/worlds/${original.id}`, { setupId: newSetup.id });
    } catch (error) {
        asked = /UPGRADE_CONFIRMATION_REQUIRED/.test(error.message);
    }
    if (!asked) throw new Error('upgrade was not confirmed first');
    const moved = await api('PATCH', `/api/worlds/${original.id}`, { setupId: newSetup.id, confirmUpgrade: true });
    if (moved.kind) await waitForJob(moved);
    const activation = await api('POST', `/api/worlds/${original.id}/activate`, { confirmUpgrade: true });
    if (activation.kind) await waitForJob(activation);
    const backups = await api('GET', `/api/backups?worldId=${original.id}`);
    if (!backups.some((backup) => backup.kind === 'pre-upgrade')) throw new Error('no pre-upgrade backup');
    log('  old world moved to the new setup with a pre-upgrade backup');

    await startAndCheck(socket);
    await stopAndCheck(socket);
    const upgraded = (await api('GET', '/api/worlds')).worlds.find((world) => world.id === original.id);
    if (upgraded.savedVersion !== latest) throw new Error(`world saved as ${upgraded.savedVersion}, expected ${latest}`);
    log(`  world now saved with ${upgraded.savedVersion}`);

    // Downgrading is refused.
    let refused = false;
    try {
        await api('PATCH', `/api/worlds/${original.id}`, { setupId: oldSetup.id, confirmUpgrade: true });
    } catch (error) {
        refused = /WORLD_TOO_NEW/.test(error.message);
    }
    if (!refused) throw new Error('downgrade was allowed');
    log('  downgrade refused');

    // A world on the old setup switches the server back.
    const legacy = await api('POST', '/api/worlds', { name: 'Old Version World', setupId: oldSetup.id });
    const back = await api('POST', `/api/worlds/${legacy.id}/activate`);
    if (back.kind) await waitForJob(back);
    const after = await api('GET', '/api/setups');
    if (after.activeSetupId !== oldSetup.id) throw new Error('did not switch back to the old setup');
    await startAndCheck(socket);
    const status = await api('GET', '/api/server/profile');
    await stopAndCheck(socket);
    log(`  switched back; running ${status.profile.loader} ${status.profile.minecraftVersion}`);
};

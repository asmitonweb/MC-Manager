const fs = require('fs');
const path = require('path');

module.exports = async ({ api, socket, log, waitForJob, startAndCheck, stopAndCheck, sandbox }) => {
    const modsDir = path.join(sandbox, 'server', 'mods');
    const providers = await api('GET', '/api/addons/providers');
    const curseforge = providers.find((p) => p.id === 'curseforge');
    if (!process.env.CURSEFORGE_API_KEY && curseforge.enabled) throw new Error('CurseForge should be disabled without a key');
    log(`  providers: ${providers.map((p) => `${p.id}=${p.enabled}`).join(', ')}`);

    const search = await api('GET', '/api/addons/search?provider=modrinth&q=lithium');
    const lithium = search.hits.find((hit) => hit.slug === 'lithium');
    if (!lithium) throw new Error('lithium not found in search');
    const preview = await api('POST', '/api/addons/install/preview', { provider: 'modrinth', items: [{ projectId: lithium.id }] });
    if (preview.blockers.length) throw new Error(`lithium blocked: ${preview.blockers}`);
    await waitForJob(await api('POST', '/api/addons/install', { provider: 'modrinth', items: [{ projectId: lithium.id }] }));
    log(`  installed lithium (${preview.install[0].versionNumber})`);

    // Find a popular server-compatible mod that needs a dependency.
    const popular = await api('GET', '/api/addons/search?provider=modrinth&sort=downloads');
    let withDeps = null;
    for (const hit of popular.hits) {
        if (hit.installed) continue;
        const candidate = await api('POST', '/api/addons/install/preview', { provider: 'modrinth', items: [{ projectId: hit.id }] });
        if (!candidate.blockers.length && candidate.dependencies.length) {
            withDeps = { hit, candidate };
            break;
        }
    }
    if (!withDeps) throw new Error('no mod with dependencies found');
    await waitForJob(await api('POST', '/api/addons/install', { provider: 'modrinth', items: [{ projectId: withDeps.hit.id }] }));
    log(`  installed ${withDeps.hit.title} with ${withDeps.candidate.dependencies.map((d) => d.title).join(', ')}`);

    fs.writeFileSync(path.join(modsDir, 'e2e-unmanaged.jar'), 'not a real mod');
    const installed = await api('GET', '/api/addons/installed');
    if (!installed.unmanaged.some((file) => file.fileName === 'e2e-unmanaged.jar')) throw new Error('unmanaged jar not reported');
    fs.rmSync(path.join(modsDir, 'e2e-unmanaged.jar'));

    let refused = false;
    await startAndCheck(socket);
    try {
        await api('POST', '/api/addons/install', { provider: 'modrinth', items: [{ projectId: lithium.id }] });
    } catch (error) {
        refused = /SERVER_RUNNING/.test(error.message);
    }
    await stopAndCheck(socket);
    if (!refused) throw new Error('install while running was allowed');
    log('  server boots with mods; changes refused while running');

    fs.writeFileSync(path.join(modsDir, 'e2e-unmanaged.jar'), 'not a real mod');
    await waitForJob(await api('POST', '/api/addons/uninstall', { provider: 'modrinth', projectId: withDeps.hit.id }));
    const after = await api('GET', '/api/addons/installed');
    const leftover = withDeps.candidate.dependencies.filter((dep) => after.mods.some((mod) => mod.projectId === dep.projectId));
    if (leftover.length) throw new Error(`orphaned dependencies left: ${leftover.map((d) => d.title)}`);
    if (!fs.existsSync(path.join(modsDir, 'e2e-unmanaged.jar'))) throw new Error('unmanaged file was removed');
    log(`  uninstalled ${withDeps.hit.title}; orphans removed; unmanaged file kept`);

    const updates = await api('GET', '/api/addons/updates');
    log(`  update check ok (${updates.length} available)`);
};

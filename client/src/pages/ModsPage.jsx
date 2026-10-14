import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, Search, Download, Trash2, RefreshCw, ScanSearch, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { inputClass, formatBytes } from '../lib/format';
import { useSocket } from '../context/SocketContext';
import { Panel, Button, Notice, Modal } from '../components/ui';
import JobProgress from '../components/JobProgress';

const ADDON_JOB_KINDS = new Set(['addon.install', 'addon.update', 'addon.uninstall', 'addon.identify', 'install']);

const formatCount = (value) => (value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value ?? 0));

const PreviewList = ({ title, entries, render }) => (entries?.length ? (
    <div>
        <div className="text-xs font-mono text-slate-500 uppercase mb-1">{title}</div>
        <ul className="space-y-1 text-sm text-slate-300">{entries.map(render)}</ul>
    </div>
) : null);

const ModsPage = () => {
    const { status, operation, jobs } = useSocket();
    const [providers, setProviders] = useState([]);
    const [provider, setProvider] = useState('modrinth');
    const [tab, setTab] = useState('browse');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('relevance');
    const [results, setResults] = useState(null);
    const [offset, setOffset] = useState(0);
    const [installed, setInstalled] = useState(null);
    const [updates, setUpdates] = useState(null);
    const [preview, setPreview] = useState(null);
    const [selectedOptional, setSelectedOptional] = useState([]);
    const [confirmUninstall, setConfirmUninstall] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [jobId, setJobId] = useState(null);

    const stopped = status === 'OFFLINE' || status === 'UNCONFIGURED';
    const busy = Boolean(operation);
    const enabledProviders = providers.filter((entry) => entry.enabled);

    const loadInstalled = useCallback(() => {
        api.get('/api/addons/installed').then(setInstalled).catch((err) => setError(err.message));
    }, []);

    useEffect(() => {
        api.get('/api/addons/providers').then(setProviders).catch((err) => setError(err.message));
        loadInstalled();
    }, [loadInstalled]);

    const search = useCallback(async (nextOffset = 0) => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ provider, q: query, sort, offset: nextOffset });
            setResults(await api.get(`/api/addons/search?${params}`));
            setOffset(nextOffset);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [provider, query, sort]);

    // Initial results, and again when provider/sort change.
    useEffect(() => {
        if (installed?.target) search(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [provider, sort, installed?.target?.mc, installed?.target?.loader]);

    const finishedKey = useMemo(() => Object.values(jobs)
        .filter((job) => ADDON_JOB_KINDS.has(job.kind) && job.status !== 'running')
        .map((job) => job.id).sort().join(','), [jobs]);
    useEffect(() => {
        if (finishedKey) {
            loadInstalled();
            setUpdates(null);
        }
    }, [finishedKey, loadInstalled]);

    const openPreview = async (items) => {
        setError(null);
        try {
            const result = await api.post('/api/addons/install/preview', { provider, items });
            setPreview({ ...result, items });
            setSelectedOptional([]);
        } catch (err) {
            setError(err.message);
        }
    };

    const toggleOptional = async (projectId) => {
        const next = selectedOptional.includes(projectId)
            ? selectedOptional.filter((id) => id !== projectId)
            : [...selectedOptional, projectId];
        setSelectedOptional(next);
        const items = [...preview.items.filter((item) => !preview.optional.some((o) => o.projectId === item.projectId)), ...next.map((id) => ({ projectId: id }))];
        try {
            const result = await api.post('/api/addons/install/preview', { provider, items });
            setPreview({ ...result, items, optional: [...result.optional, ...preview.optional.filter((o) => next.includes(o.projectId))] });
        } catch (err) {
            setError(err.message);
        }
    };

    const startJob = async (request) => {
        setError(null);
        try {
            const job = await request();
            setJobId(job.id);
            setPreview(null);
            setConfirmUninstall(null);
        } catch (err) {
            setError(err.message);
        }
    };

    const checkUpdates = async () => {
        setError(null);
        setUpdates(null);
        try {
            setUpdates(await api.get('/api/addons/updates'));
        } catch (err) {
            setError(err.message);
        }
    };

    const target = installed?.target;
    const available = (updates || []).filter((entry) => !entry.error);

    return (
        <Panel title="Mods" icon={Package} className="h-full">
            <div className="space-y-4">
                {installed && !target && (
                    <Notice tone="warn">Install the server first; mods are matched to its version and loader. <Link to="/server" className="underline">Go to Server</Link></Notice>
                )}
                {target && (
                    <div className="text-sm text-slate-400">
                        Showing mods for <span className="text-cyan-300 font-mono">{target.loader === 'fabric' ? 'Fabric' : 'Forge'} · Minecraft {target.mc}</span>.
                        Changes apply on the next start{!stopped && ' — stop the server to install, update or remove mods'}.
                    </div>
                )}
                {providers.filter((entry) => !entry.enabled).map((entry) => <Notice key={entry.id} tone="info">{entry.reason}</Notice>)}
                {error && <Notice tone="error">{error}</Notice>}
                {jobId && <JobProgress jobId={jobId} />}

                <div className="flex gap-2 bg-slate-950 p-1 rounded-lg w-fit">
                    {[['browse', 'Browse'], ['installed', `Installed (${installed?.mods.length ?? 0})`], ['updates', 'Updates']].map(([key, label]) => (
                        <button key={key} type="button" onClick={() => setTab(key)}
                            className={`px-3 py-1 text-xs font-bold rounded ${tab === key ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}>
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'browse' && target && (
                    <div className="space-y-4">
                        <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); search(0); }}>
                            {enabledProviders.length > 1 && (
                                <select className={`${inputClass} w-auto`} value={provider} onChange={(e) => setProvider(e.target.value)}>
                                    {enabledProviders.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                                </select>
                            )}
                            <div className="relative flex-1 min-w-[12rem]">
                                <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                                <input className={`${inputClass} pl-9`} placeholder="Search server-compatible mods" value={query} onChange={(e) => setQuery(e.target.value)} />
                            </div>
                            <select className={`${inputClass} w-auto`} value={sort} onChange={(e) => setSort(e.target.value)}>
                                <option value="relevance">Relevance</option>
                                <option value="downloads">Downloads</option>
                                <option value="updated">Recently updated</option>
                                <option value="newest">Newest</option>
                            </select>
                            <Button type="submit" icon={Search} disabled={loading}>Search</Button>
                        </form>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                            {results?.hits.map((hit) => (
                                <div key={hit.id} className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex gap-3">
                                    {hit.iconUrl
                                        ? <img src={hit.iconUrl} alt="" className="w-12 h-12 rounded bg-slate-900 shrink-0" loading="lazy" />
                                        : <div className="w-12 h-12 rounded bg-slate-900 shrink-0" />}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <a href={hit.url} target="_blank" rel="noreferrer" className="font-bold text-white hover:text-cyan-300 inline-flex items-center gap-1">
                                                    {hit.title} <ExternalLink className="w-3 h-3" />
                                                </a>
                                                {hit.author && <div className="text-xs text-slate-500">by {hit.author}</div>}
                                            </div>
                                            {hit.installed
                                                ? <span className="text-xs text-green-400 font-bold">INSTALLED</span>
                                                : <Button icon={Download} disabled={!stopped || busy} title={stopped ? 'Install' : 'Stop the server first'} onClick={() => openPreview([{ projectId: hit.id }])}>Install</Button>}
                                        </div>
                                        <p className="text-sm text-slate-400 mt-1 line-clamp-2">{hit.description}</p>
                                        <div className="flex flex-wrap gap-1 mt-2 text-xs">
                                            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">{formatCount(hit.downloads)} downloads</span>
                                            {hit.serverSide === 'required' && <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300">server</span>}
                                            {hit.clientSide === 'required' && <span className="px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-300">players need it too</span>}
                                            {hit.categories.slice(0, 3).map((category) => <span key={category} className="px-2 py-0.5 rounded bg-slate-900 text-slate-500">{category}</span>)}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {results && (
                            <div className="flex items-center gap-2 text-sm text-slate-500">
                                <Button variant="secondary" disabled={offset === 0 || loading} onClick={() => search(Math.max(0, offset - 20))}>Previous</Button>
                                <span>{results.total ? `${offset + 1}–${Math.min(offset + 20, results.total)} of ${results.total}` : 'No results'}</span>
                                <Button variant="secondary" disabled={offset + 20 >= results.total || loading} onClick={() => search(offset + 20)}>Next</Button>
                            </div>
                        )}
                    </div>
                )}

                {tab === 'installed' && installed && (
                    <div className="space-y-4">
                        {!installed.mods.length && <p className="text-sm text-slate-500">No mods installed by MC Manager yet.</p>}
                        <div className="space-y-2">
                            {installed.mods.map((mod) => (
                                <div key={`${mod.provider}:${mod.projectId}`} className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex items-center gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-slate-200 font-medium truncate">
                                            {mod.title} <span className="text-xs text-slate-500 font-mono">{mod.versionNumber}</span>
                                        </div>
                                        <div className="text-xs text-slate-500 truncate">
                                            {mod.fileName} · {mod.provider}{!mod.explicit && ' · dependency'}
                                            {!mod.present && <span className="text-red-400"> · file missing</span>}
                                            {!mod.compatible && <span className="text-yellow-400"> · built for {mod.loader} {mod.minecraftVersion}</span>}
                                        </div>
                                    </div>
                                    <Button variant="ghost" icon={Trash2} title="Uninstall" disabled={!stopped || busy} onClick={() => setConfirmUninstall(mod)} />
                                </div>
                            ))}
                        </div>
                        {installed.unmanaged.length > 0 && (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="text-xs font-mono text-slate-500 uppercase">Unmanaged files in mods\ (never changed by MC Manager)</div>
                                    <Button variant="secondary" icon={ScanSearch} disabled={busy || !target} onClick={() => startJob(() => api.post('/api/addons/identify'))}>Identify</Button>
                                </div>
                                {installed.unmanaged.map((file) => (
                                    <div key={file.fileName} className="text-sm text-slate-400 font-mono bg-slate-950 border border-slate-800 rounded px-3 py-2 flex justify-between">
                                        <span className="truncate">{file.fileName}</span><span>{formatBytes(file.sizeBytes)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'updates' && (
                    <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" icon={RefreshCw} onClick={checkUpdates} disabled={!target}>Check for updates</Button>
                            {available.length > 0 && (
                                <Button icon={Download} disabled={!stopped || busy}
                                    onClick={() => startJob(() => api.post('/api/addons/update', { provider: 'modrinth', projectIds: available.filter((u) => u.provider === 'modrinth').map((u) => u.projectId) }))}>
                                    Update all ({available.length})
                                </Button>
                            )}
                        </div>
                        {updates && !updates.length && <p className="text-sm text-slate-500">Everything is up to date.</p>}
                        {updates?.map((entry) => (
                            <div key={`${entry.provider}:${entry.projectId}`} className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm flex items-center justify-between gap-2">
                                <span className="text-slate-200">{entry.title}</span>
                                {entry.error
                                    ? <span className="text-red-400 text-xs">{entry.error}</span>
                                    : <span className="font-mono text-xs text-slate-400">{entry.from} → <span className="text-cyan-300">{entry.to}</span></span>}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {preview && (
                <Modal title="Install mods" onClose={() => setPreview(null)} footer={<>
                    <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
                    <Button icon={Download} disabled={preview.blockers.length > 0 || !stopped || busy}
                        onClick={() => startJob(() => api.post('/api/addons/install', { provider, items: preview.items }))}>
                        Install selected and dependencies
                    </Button>
                </>}>
                    <PreviewList title="Install" entries={preview.install} render={(entry) => (
                        <li key={entry.projectId}>{entry.title} <span className="font-mono text-xs text-slate-500">{entry.versionNumber} · {formatBytes(entry.size)}</span></li>
                    )} />
                    <PreviewList title="Required dependencies" entries={preview.dependencies} render={(entry) => (
                        <li key={entry.projectId}>{entry.title} <span className="font-mono text-xs text-slate-500">{entry.versionNumber}</span> <span className="text-xs text-slate-500">for {entry.requiredBy.join(', ')}</span></li>
                    )} />
                    <PreviewList title="Already installed" entries={preview.alreadyInstalled} render={(entry) => <li key={entry.projectId} className="text-slate-500">{entry.title}</li>} />
                    <PreviewList title="Optional (not installed unless ticked)" entries={preview.optional} render={(entry) => (
                        <li key={entry.projectId}>
                            <label className="flex items-center gap-2">
                                <input type="checkbox" checked={selectedOptional.includes(entry.projectId)} onChange={() => toggleOptional(entry.projectId)} />
                                {entry.title} <span className="text-xs text-slate-500">suggested by {entry.suggestedBy}</span>
                            </label>
                        </li>
                    )} />
                    {preview.blockers.map((blocker) => <Notice key={blocker} tone="error">{blocker}</Notice>)}
                    {preview.manualDownload?.map((entry) => entry.url && (
                        <a key={entry.projectId} href={entry.url} target="_blank" rel="noreferrer" className="text-sm text-cyan-400 underline block">Download {entry.title} manually</a>
                    ))}
                    <p className="text-xs text-slate-500">Destination: server\mods. Files are verified against the provider's checksums before installing.</p>
                </Modal>
            )}

            {confirmUninstall && (
                <Modal title={`Uninstall ${confirmUninstall.title}`} onClose={() => setConfirmUninstall(null)} footer={<>
                    <Button variant="ghost" onClick={() => setConfirmUninstall(null)}>Cancel</Button>
                    <Button variant="danger" icon={Trash2}
                        onClick={() => startJob(() => api.post('/api/addons/uninstall', { provider: confirmUninstall.provider, projectId: confirmUninstall.projectId, removeOrphanDeps: true }))}>
                        Uninstall
                    </Button>
                </>}>
                    <p className="text-sm text-slate-300">
                        {confirmUninstall.fileName} is moved to manager-data\mod-backups (kept for 7 days). Dependencies that nothing else needs are removed too.
                    </p>
                </Modal>
            )}
        </Panel>
    );
};

export default ModsPage;

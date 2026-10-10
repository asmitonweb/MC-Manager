import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Gamepad2, Copy, Check, Search, Plus, Trash2, Sparkles, Image as ImageIcon, Package, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { inputClass, formatBytes } from '../lib/format';
import { useSocket } from '../context/SocketContext';
import { Panel, Button, Notice, Modal, Field } from '../components/ui';
import JobProgress from '../components/JobProgress';

const TYPES = [
    { id: 'mod', label: 'Client mods', icon: Package, hint: 'Performance, minimaps, HUDs: things only players run.' },
    { id: 'shader', label: 'Shaders', icon: Sparkles, hint: 'Adds Iris and Sodium automatically.' },
    { id: 'resourcepack', label: 'Resource packs', icon: ImageIcon, hint: 'Shared with the player\'s own packs; only ours are ever removed.' },
];
const KIND_LABEL = { mods: 'Mod', shaderpacks: 'Shader', resourcepacks: 'Resource pack' };

const CopyField = ({ label, value }) => {
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setCopied(false);
        }
    };
    return (
        <Field label={label}>
            <div className="flex gap-2">
                <input readOnly value={value} className={`${inputClass} font-mono text-xs`} onFocus={(e) => e.target.select()} />
                <Button variant="secondary" icon={copied ? Check : Copy} onClick={copy} title="Copy" />
            </div>
        </Field>
    );
};

const GameSyncPage = () => {
    const { jobs, operation } = useSocket();
    const [data, setData] = useState(null);
    const [setupId, setSetupId] = useState('');
    const [type, setType] = useState('mod');
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [preview, setPreview] = useState(null);
    const [clientName, setClientName] = useState('');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [jobId, setJobId] = useState(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        try {
            const next = await api.get('/api/client');
            setData(next);
            setClientName(next.clientName);
            setSetupId((current) => current || next.setups.find((s) => s.active)?.id || next.setups[0]?.id || '');
        } catch (err) {
            setError(err.message);
        }
    }, []);
    useEffect(() => { load(); }, [load]);

    const finishedKey = useMemo(() => Object.values(jobs)
        .filter((job) => job.kind === 'client.install' && job.status !== 'running')
        .map((job) => job.id).sort().join(','), [jobs]);
    useEffect(() => { if (finishedKey) load(); }, [finishedKey, load]);

    const setup = data?.setups.find((s) => s.id === setupId);

    const search = useCallback(async () => {
        if (!setupId) return;
        setLoading(true);
        setError(null);
        try {
            setResults(await api.get(`/api/client/search?${new URLSearchParams({ setupId, type, q: query })}`));
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [setupId, type, query]);
    // Fresh results when the setup or type changes; typing waits for Enter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { if (setup?.loader === 'fabric') search(); }, [setupId, type]);

    const openPreview = async (projectId) => {
        setError(null);
        try {
            setPreview({ ...(await api.post('/api/client/preview', { setupId, type, projectId })), projectId });
        } catch (err) {
            setError(err.message);
        }
    };

    const install = async () => {
        setError(null);
        try {
            const job = await api.post('/api/client/install', { setupId, type, projectId: preview.projectId });
            setJobId(job.id);
            setPreview(null);
        } catch (err) {
            setError(err.message);
        }
    };

    const remove = async (projectId) => {
        setError(null);
        try {
            const { removed } = await api.post('/api/client/remove', { setupId, projectId });
            setNotice(`Removed ${removed.join(', ')}. Players lose it on their next launch.`);
            load();
        } catch (err) {
            setError(err.message);
        }
    };

    const saveName = async () => {
        try {
            const next = await api.put('/api/client', { clientName });
            setData(next);
            setNotice('Launcher name saved. Players get the new entry names on their next launch.');
        } catch (err) {
            setError(err.message);
        }
    };

    if (!data) return <div className="text-slate-500 font-mono text-sm">{error || 'Loading…'}</div>;

    return (
        <div className="space-y-6 max-w-5xl">
            {error && <Notice tone="error">{error}</Notice>}
            {notice && <Notice tone="success">{notice}</Notice>}

            <Panel title="Players' one-click setup" icon={Gamepad2}>
                <div className="space-y-4">
                    {!data.agentReady && <Notice tone="warn">The sync agent has not been built on this machine. Deploy with windows/deploy-to-mc-pc.sh (it builds client-agent/dist/agent.jar).</Notice>}
                    <p className="text-sm text-slate-400">
                        Players run this once. It adds a <span className="text-cyan-300">{data.brand.name}</span> entry per setup to TLauncher, SKLauncher and the official launcher.
                        After that, every press of Play syncs mods, shaders and resource packs, without touching the player&apos;s own files.
                    </p>
                    <CopyField label="Setup file (share in Discord)" value={data.setupUrl} />
                    <CopyField label="Or paste into Win + R" value={data.setupCommand} />
                    <div className="grid md:grid-cols-[1fr_auto] gap-2 items-end">
                        <Field label="Launcher name" hint={`Entries show as "${clientName || data.brand.name} · <world>". Defaults to the first part of the Discord server name.`}>
                            <input className={inputClass} value={clientName} maxLength={40} placeholder={data.brand.name} onChange={(e) => setClientName(e.target.value)} />
                        </Field>
                        <Button variant="secondary" onClick={saveName}>Save</Button>
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                        Synced players: {data.clients.last24h} in the last 24 h · {data.clients.last7d} this week. Regenerating the link on the Discord page also changes this one.
                    </div>
                </div>
            </Panel>

            <Panel title="What players get" icon={Package} actions={
                <select className={`${inputClass} !w-auto !py-1 text-xs`} value={setupId} onChange={(e) => { setSetupId(e.target.value); setResults(null); }}>
                    {data.setups.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.loader} {s.minecraftVersion}){s.active ? ' · active' : ''}</option>)}
                </select>
            }>
                {setup && (
                    <div className="space-y-4">
                        {!setup.autoSync && (
                            <Notice tone="warn">
                                {setup.loader !== 'fabric' ? 'Forge setups cannot be synced automatically; players use the mods zip.' : `Not syncable yet: ${setup.versionError || 'unknown error'}`}
                            </Notice>
                        )}
                        <div className="text-xs text-slate-500 font-mono">Launcher entry: <span className="text-slate-300">{setup.label}</span> ({setup.versionId})</div>
                        {setup.files.length ? (
                            <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg">
                                {setup.files.map((file) => {
                                    const extra = setup.extras.find((entry) => entry.kind === file.kind && entry.fileName === file.name);
                                    return (
                                        <div key={`${file.kind}/${file.name}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                                            <span className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded ${file.source === 'server' ? 'bg-slate-800 text-slate-400' : 'bg-cyan-500/10 text-cyan-300'}`}>
                                                {file.source === 'server' ? 'server mod' : KIND_LABEL[file.kind]}
                                            </span>
                                            <span className="flex-1 min-w-0 truncate text-slate-200">{file.title}{file.versionNumber && <span className="text-slate-500 font-mono"> {file.versionNumber}</span>}</span>
                                            <span className="text-xs text-slate-500 font-mono">{formatBytes(file.size)}</span>
                                            {extra && (
                                                <Button variant="ghost" icon={Trash2} title="Remove" disabled={Boolean(operation)} onClick={() => remove(extra.projectId)} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : <div className="text-sm text-slate-500">Nothing to sync: vanilla Minecraft {setup.minecraftVersion} is enough.</div>}
                        <p className="text-xs text-slate-500">Server mods appear here automatically (except server-only ones). Add client-only extras below.</p>
                        {jobId && <JobProgress jobId={jobId} showLog={false} />}
                    </div>
                )}
            </Panel>

            {setup?.loader === 'fabric' && (
                <Panel title="Add client extras" icon={Plus}>
                    <div className="space-y-4">
                        <div className="flex flex-wrap gap-2">
                            {TYPES.map(({ id, label, icon: Icon }) => (
                                <Button key={id} variant={type === id ? 'primary' : 'secondary'} icon={Icon} onClick={() => { setType(id); setResults(null); }}>{label}</Button>
                            ))}
                        </div>
                        <p className="text-xs text-slate-500">{TYPES.find((t) => t.id === type).hint}</p>
                        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
                            <input className={inputClass} value={query} placeholder={`Search Modrinth for Minecraft ${setup.minecraftVersion}`} onChange={(e) => setQuery(e.target.value)} />
                            <Button type="submit" icon={Search} disabled={loading}>Search</Button>
                        </form>
                        <div className="grid md:grid-cols-2 gap-3">
                            {results?.hits.map((hit) => (
                                <div key={hit.id} className="flex gap-3 p-3 bg-slate-950 border border-slate-800 rounded-lg">
                                    {hit.iconUrl ? <img src={hit.iconUrl} alt="" loading="lazy" className="w-10 h-10 rounded" /> : <div className="w-10 h-10 rounded bg-slate-800" />}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-1 text-sm text-slate-200 font-medium truncate">
                                            {hit.title}
                                            <a href={hit.url} target="_blank" rel="noreferrer" className="text-slate-500 hover:text-cyan-300"><ExternalLink className="w-3 h-3" /></a>
                                        </div>
                                        <div className="text-xs text-slate-500 line-clamp-2">{hit.description}</div>
                                    </div>
                                    <Button variant={hit.installed ? 'ghost' : 'secondary'} disabled={hit.installed || Boolean(operation)} onClick={() => openPreview(hit.id)}>
                                        {hit.installed ? 'Added' : 'Add'}
                                    </Button>
                                </div>
                            ))}
                        </div>
                        {results && !results.hits.length && <div className="text-sm text-slate-500">No results for Minecraft {setup.minecraftVersion}.</div>}
                    </div>
                </Panel>
            )}

            {preview && (
                <Modal title="Add for players" onClose={() => setPreview(null)} footer={<>
                    <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
                    <Button disabled={preview.unavailable.length > 0} onClick={install}>Add</Button>
                </>}>
                    <ul className="space-y-1 text-sm text-slate-300">
                        {preview.items.map((item) => (
                            <li key={item.projectId}>
                                <span className="text-slate-500 font-mono text-xs">{KIND_LABEL[item.kind]}</span> {item.title} <span className="font-mono text-slate-500">{item.versionNumber}</span>
                                {item.requiredBy.length > 0 && <span className="text-xs text-slate-500"> · needed by {item.requiredBy.join(', ')}</span>}
                            </li>
                        ))}
                    </ul>
                    {preview.unavailable.length > 0 && (
                        <Notice tone="error">No version for Minecraft {preview.target.mc}: {preview.unavailable.map((e) => e.title).join(', ')}</Notice>
                    )}
                    <p className="text-xs text-slate-500">Players receive these on their next launch. The server is not changed.</p>
                </Modal>
            )}
        </div>
    );
};

export default GameSyncPage;

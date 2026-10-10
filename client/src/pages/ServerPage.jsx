import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { HardDrive, ChevronLeft, ChevronRight, Download, RefreshCw, Save, Search, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { inputClass, formatDate } from '../lib/format';
import { useSocket } from '../context/SocketContext';
import { Panel, Button, Field, Notice } from '../components/ui';
import JobProgress from '../components/JobProgress';

const STEPS = ['Loader', 'Minecraft', 'Loader version', 'Java & memory', 'Review'];

const LOADER_INFO = {
    fabric: 'Lightweight and quick to update. Most performance mods target Fabric.',
    forge: 'The classic loader for large content mods. Minecraft 1.17 and later.',
};

// Starts Minecraft whenever the manager starts (the manager itself starts at Windows logon).
const AutoStart = () => {
    const [enabled, setEnabled] = useState(null);
    useEffect(() => {
        api.get('/api/server/autostart').then((result) => setEnabled(result.enabled)).catch(() => {});
    }, []);
    const toggle = async () => {
        const result = await api.put('/api/server/autostart', { enabled: !enabled });
        setEnabled(result.enabled);
    };
    if (enabled === null) return null;
    return (
        <label className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl p-4 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={toggle} className="w-4 h-4 accent-cyan-500" />
            <div>
                <div className="text-sm text-slate-200">Start Minecraft automatically</div>
                <div className="text-xs text-slate-500">When the manager starts (for example after the PC reboots and logs in), the active world starts too.</div>
            </div>
        </label>
    );
};

const ProfileSummary = ({ options, onReinstall, onSaved }) => {
    const { profile } = options;
    const { status } = useSocket();
    const [memory, setMemory] = useState(profile.memory);
    const [javaPath, setJavaPath] = useState(profile.javaPath);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);
    const suitableJava = options.java.filter((runtime) => runtime.major >= profile.requiredJavaMajor);

    const save = async () => {
        setSaving(true);
        setMessage(null);
        try {
            await api.patch('/api/server/profile', { memory, javaPath });
            setMessage({ tone: 'success', text: 'Saved. Changes apply the next time the server starts.' });
            onSaved();
        } catch (error) {
            setMessage({ tone: 'error', text: error.message });
        } finally {
            setSaving(false);
        }
    };

    const rows = [
        ['Loader', `${profile.loader === 'fabric' ? 'Fabric' : 'Forge'} ${profile.loaderVersion}`],
        ['Minecraft', profile.minecraftVersion],
        ['Java', `Java ${profile.javaMajor} (requires ${profile.requiredJavaMajor}+)`],
        ['Installed', formatDate(profile.installedAt)],
    ];

    return (
        <div className="space-y-6 max-w-3xl">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {rows.map(([label, value]) => (
                    <div key={label} className="bg-slate-950 border border-slate-800 rounded-lg p-4">
                        <div className="text-xs font-mono text-slate-500 uppercase">{label}</div>
                        <div className="text-slate-200 mt-1 break-words">{value}</div>
                    </div>
                ))}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Field label="Minimum memory">
                    <input className={inputClass} value={memory.min} onChange={(e) => setMemory({ ...memory, min: e.target.value })} />
                </Field>
                <Field label="Maximum memory">
                    <input className={inputClass} value={memory.max} onChange={(e) => setMemory({ ...memory, max: e.target.value })} />
                </Field>
                <Field label="Java runtime">
                    <select className={inputClass} value={javaPath} onChange={(e) => setJavaPath(e.target.value)}>
                        {suitableJava.map((runtime) => (
                            <option key={runtime.path} value={runtime.path}>Java {runtime.major} — {runtime.vendor || runtime.path}</option>
                        ))}
                    </select>
                </Field>
            </div>
            {message && <Notice tone={message.tone}>{message.text}</Notice>}
            <div className="flex flex-wrap gap-2">
                <Button icon={Save} onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save settings'}</Button>
                <Button variant="secondary" icon={RefreshCw} onClick={onReinstall} disabled={status !== 'OFFLINE'}>
                    Reinstall this setup
                </Button>
            </div>
            {status !== 'OFFLINE' && <p className="text-xs text-slate-500">Stop the server to reinstall it.</p>}
        </div>
    );
};

const Wizard = ({ options, reinstall, newSetup = false, onCancel, onInstalled }) => {
    const { status } = useSocket();
    const [step, setStep] = useState(0);
    const [loader, setLoader] = useState(options.profile?.loader || 'fabric');
    const [versions, setVersions] = useState(null);
    const [mc, setMc] = useState('');
    const [filter, setFilter] = useState('');
    const [loaderVersions, setLoaderVersions] = useState(null);
    const [loaderVersion, setLoaderVersion] = useState('');
    const [javaPath, setJavaPath] = useState('');
    const [memory, setMemory] = useState(options.profile?.memory || options.defaults.memory);
    const [worldName, setWorldName] = useState('World');
    const [preview, setPreview] = useState(null);
    const [acceptEula, setAcceptEula] = useState(false);
    const [acceptJavaRisk, setAcceptJavaRisk] = useState(false);
    const [error, setError] = useState(null);
    const [job, setJob] = useState(null);
    const { jobs } = useSocket();
    const liveJob = job ? jobs[job.id] || job : null;

    useEffect(() => {
        let cancelled = false;
        api.get(`/api/server/install/versions?loader=${loader}`)
            .then((list) => {
                if (cancelled) return;
                setVersions(list);
                setMc((current) => (list.some((v) => v.id === current) ? current : list[0]?.id || ''));
            })
            .catch((err) => !cancelled && setError(err.message));
        return () => { cancelled = true; };
    }, [loader]);

    useEffect(() => {
        if (!mc) return undefined;
        let cancelled = false;
        api.get(`/api/server/install/loaders?loader=${loader}&mc=${encodeURIComponent(mc)}`)
            .then((list) => {
                if (cancelled) return;
                setLoaderVersions(list);
                setLoaderVersion((list.find((entry) => entry.recommended) || list[0])?.version || '');
            })
            .catch((err) => !cancelled && setError(err.message));
        return () => { cancelled = true; };
    }, [loader, mc]);

    const request = useMemo(() => ({
        loader,
        minecraftVersion: mc,
        loaderVersion,
        javaPath: javaPath || undefined,
        memory,
        worldName,
        newSetup,
    }), [loader, mc, loaderVersion, javaPath, memory, worldName, newSetup]);

    const loadPreview = useCallback(async () => {
        setError(null);
        setPreview(null);
        try {
            const result = await api.post('/api/server/install/preview', request);
            setPreview(result);
            if (!javaPath && result.java) setJavaPath(result.java.path);
        } catch (err) {
            setError(err.message);
        }
    }, [request, javaPath]);

    const goTo = (next) => {
        setError(null);
        setStep(next);
        if (next >= 3) loadPreview();
    };

    useEffect(() => {
        if (liveJob?.status === 'succeeded') onInstalled();
    }, [liveJob?.status, onInstalled]);

    const install = async () => {
        setError(null);
        try {
            setJob(await api.post('/api/server/install', { ...request, acceptEula, acceptJavaRisk, reinstall: reinstall && !newSetup }));
        } catch (err) {
            setError(err.message);
        }
    };

    const visibleVersions = (versions || []).filter((v) => v.id.includes(filter.trim())).slice(0, 60);
    const installing = liveJob && liveJob.status === 'running';

    if (liveJob) {
        return (
            <div className="space-y-4 max-w-3xl">
                <JobProgress jobId={liveJob.id} initialJob={liveJob} />
                {liveJob.status === 'failed' && <Button variant="secondary" onClick={() => setJob(null)}>Back to the wizard</Button>}
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-3xl">
            {newSetup && (
                <Notice tone="info">
                    This adds a separate setup. The current one (with its mods and worlds) is kept and comes back automatically when
                    you activate one of its worlds.
                </Notice>
            )}
            {reinstall && !newSetup && (
                <Notice tone="warn">
                    Reinstalling replaces the loader and libraries. Worlds, mods, config and server.properties are kept; the old
                    loader files are moved to backups\server-install. Mods built for another version or loader will stop working.
                </Notice>
            )}

            <ol className="flex flex-wrap gap-2">
                {STEPS.map((label, index) => (
                    <li key={label} className={`px-3 py-1 rounded-full text-xs font-mono ${index === step ? 'bg-cyan-500/20 text-cyan-300' : index < step ? 'bg-slate-800 text-slate-300' : 'bg-slate-900 text-slate-600 border border-slate-800'}`}>
                        {index + 1}. {label}
                    </li>
                ))}
            </ol>

            {step === 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {options.loaders.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            onClick={() => setLoader(entry.id)}
                            className={`text-left p-5 rounded-xl border transition-colors ${loader === entry.id ? 'border-cyan-500 bg-cyan-500/10' : 'border-slate-800 bg-slate-950 hover:border-slate-600'}`}
                        >
                            <div className="text-lg font-bold text-white">{entry.name}</div>
                            <div className="text-sm text-slate-400 mt-1">{LOADER_INFO[entry.id]}</div>
                        </button>
                    ))}
                </div>
            )}

            {step === 1 && (
                <div className="space-y-3">
                    <div className="relative">
                        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input className={`${inputClass} pl-9`} placeholder="Filter versions" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    </div>
                    {!versions && <p className="text-slate-500 text-sm">Loading versions...</p>}
                    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                        {visibleVersions.map((version) => (
                            <button
                                key={version.id}
                                type="button"
                                onClick={() => setMc(version.id)}
                                className={`px-2 py-2 rounded-lg text-sm font-mono border ${mc === version.id ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-slate-800 bg-slate-950 text-slate-300 hover:border-slate-600'}`}
                            >
                                {version.id}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {step === 2 && (
                <Field label={`${loader === 'fabric' ? 'Fabric loader' : 'Forge'} version for Minecraft ${mc}`}>
                    <select className={inputClass} value={loaderVersion} onChange={(e) => setLoaderVersion(e.target.value)}>
                        {(loaderVersions || []).map((entry) => (
                            <option key={entry.version} value={entry.version}>
                                {entry.version}{entry.recommended ? ' (recommended)' : ''}{!entry.stable && !entry.recommended ? ' — beta' : ''}
                            </option>
                        ))}
                    </select>
                </Field>
            )}

            {step === 3 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Java runtime" hint={preview ? `Minecraft ${mc} needs Java ${preview.requiredJava} or newer.` : undefined}>
                        <select className={inputClass} value={javaPath} onChange={(e) => setJavaPath(e.target.value)}>
                            {options.java.map((runtime) => (
                                <option key={runtime.path} value={runtime.path}>
                                    {preview && runtime.major >= preview.requiredJava ? '✓' : '✗'} Java {runtime.major} — {runtime.vendor || runtime.path}
                                </option>
                            ))}
                        </select>
                    </Field>
                    {!options.profile && !options.existingInstall && (
                        <Field label="First world name">
                            <input className={inputClass} value={worldName} onChange={(e) => setWorldName(e.target.value)} />
                        </Field>
                    )}
                    <Field label="Minimum memory" hint="e.g. 2G">
                        <input className={inputClass} value={memory.min} onChange={(e) => setMemory({ ...memory, min: e.target.value })} />
                    </Field>
                    <Field label="Maximum memory" hint={`This PC has ${(options.totalMemory / 1024 ** 3).toFixed(0)} GB.`}>
                        <input className={inputClass} value={memory.max} onChange={(e) => setMemory({ ...memory, max: e.target.value })} />
                    </Field>
                </div>
            )}

            {step === 4 && (
                <div className="space-y-4">
                    {!preview && !error && <p className="text-slate-500 text-sm">Checking...</p>}
                    {preview && (
                        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 text-sm space-y-1 font-mono text-slate-300">
                            <div>Loader: {preview.loader} {preview.loaderVersion}</div>
                            <div>Minecraft: {preview.minecraftVersion}</div>
                            <div>Java: {preview.java ? `Java ${preview.java.major}` : 'none'} (needs {preview.requiredJava}+)</div>
                            <div>Memory: {preview.memory.min} – {preview.memory.max}</div>
                            {preview.createsWorld && <div>First world: {preview.worldName}</div>}
                            <div>Folder: {preview.targetDir}</div>
                        </div>
                    )}
                    {preview?.warnings.map((warning) => <Notice key={warning} tone="warn">{warning}</Notice>)}
                    {preview?.javaRisk && (
                        <label className="flex items-start gap-2 text-sm text-slate-300">
                            <input type="checkbox" className="mt-1" checked={acceptJavaRisk} onChange={(e) => setAcceptJavaRisk(e.target.checked)} />
                            I understand this Java version may not work with this Forge release.
                        </label>
                    )}
                    <label className="flex items-start gap-2 text-sm text-slate-300">
                        <input type="checkbox" className="mt-1" checked={acceptEula} onChange={(e) => setAcceptEula(e.target.checked)} />
                        <span>
                            I accept the{' '}
                            <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="text-cyan-400 underline">Minecraft EULA</a>.
                        </span>
                    </label>
                </div>
            )}

            {error && <Notice tone="error">{error}</Notice>}

            <div className="flex flex-wrap gap-2">
                {step > 0 && <Button variant="secondary" icon={ChevronLeft} onClick={() => goTo(step - 1)}>Back</Button>}
                {step < STEPS.length - 1 && (
                    <Button icon={ChevronRight} onClick={() => goTo(step + 1)} disabled={(step === 1 && !mc) || (step === 2 && !loaderVersion)}>
                        Next
                    </Button>
                )}
                {step === STEPS.length - 1 && (
                    <Button
                        icon={Download}
                        onClick={install}
                        disabled={installing || !preview || !preview.javaOk || !acceptEula || (preview.javaRisk && !acceptJavaRisk) || status !== 'OFFLINE' && status !== 'UNCONFIGURED'}
                    >
                        Install server
                    </Button>
                )}
                {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
            </div>
        </div>
    );
};

const SetupList = ({ setups, onAdd, onChanged }) => {
    const { status } = useSocket();
    const [error, setError] = useState(null);
    const remove = async (id) => {
        setError(null);
        try {
            await api.delete(`/api/setups/${id}`);
            onChanged();
        } catch (err) {
            setError(err.message);
        }
    };
    return (
        <div className="space-y-3 max-w-3xl mb-8">
            <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-mono text-slate-500 uppercase">Setups (one per version; each world uses one)</div>
                <Button variant="secondary" icon={Plus} onClick={onAdd} disabled={status !== 'OFFLINE'} title={status !== 'OFFLINE' ? 'Stop the server first' : undefined}>
                    Add a setup for another version
                </Button>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {setups.map((setup) => (
                    <div key={setup.id} className={`bg-slate-950 border rounded-lg p-4 space-y-1 ${setup.active ? 'border-cyan-500/50' : 'border-slate-800'}`}>
                        <div className="flex items-center justify-between gap-2">
                            <div className="font-bold text-white">{setup.loader === 'fabric' ? 'Fabric' : 'Forge'} · Minecraft {setup.minecraftVersion}</div>
                            {setup.active
                                ? <span className="px-2 py-0.5 rounded text-xs font-bold bg-cyan-500/20 text-cyan-300">ACTIVE</span>
                                : !setup.worlds.length && <Button variant="ghost" icon={Trash2} title="Remove this unused setup" onClick={() => remove(setup.id)} />}
                        </div>
                        <div className="text-xs text-slate-400">Worlds: {setup.worlds.map((w) => w.name).join(', ') || '—'}</div>
                        <div className="text-xs text-slate-400">Mods: {setup.mods.map((m) => m.title).join(', ') || 'none (vanilla clients can join)'}</div>
                    </div>
                ))}
            </div>
        </div>
    );
};

const ServerPage = () => {
    const [options, setOptions] = useState(null);
    const [setups, setSetups] = useState([]);
    const [error, setError] = useState(null);
    const [mode, setMode] = useState(null); // null | 'reinstall' | 'new'
    const reinstalling = mode !== null;
    const setReinstalling = (value) => setMode(value ? 'reinstall' : null);

    const load = useCallback(() => {
        api.get('/api/server/install/options')
            .then((data) => {
                setOptions(data);
                setError(null);
            })
            .catch((err) => setError(err.message));
        api.get('/api/setups').then((data) => setSetups(data.setups)).catch(() => {});
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const onInstalled = useCallback(() => {
        setReinstalling(false);
        load();
    }, [load]);

    return (
        <Panel title={mode === 'new' ? 'Add a setup' : options?.profile && !reinstalling ? 'Server installation' : 'Install Minecraft server'} icon={HardDrive} className="h-full">
            {error && <Notice tone="error">{error}</Notice>}
            {!options && !error && <p className="text-slate-500">Loading...</p>}
            {options && options.profile && !reinstalling && setups.length > 0 && (
                <SetupList setups={setups} onAdd={() => setMode('new')} onChanged={load} />
            )}
            {options && options.profile && !reinstalling && (
                <div className="space-y-4">
                    <ProfileSummary options={options} onReinstall={() => setReinstalling(true)} onSaved={load} />
                    <AutoStart />
                </div>
            )}
            {options && (!options.profile || reinstalling) && (
                <Wizard
                    options={options}
                    reinstall={Boolean(options.profile || options.existingInstall)}
                    newSetup={mode === 'new'}
                    onCancel={options.profile ? () => setReinstalling(false) : null}
                    onInstalled={onInstalled}
                />
            )}
        </Panel>
    );
};

export default ServerPage;

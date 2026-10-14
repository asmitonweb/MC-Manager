import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    Globe, Plus, Upload, Archive, Play, Pencil, Copy, Download, Trash2, RotateCcw, ShieldCheck, FolderInput,
} from 'lucide-react';
import { api } from '../lib/api';
import { inputClass, formatBytes, formatDate } from '../lib/format';
import { useSocket } from '../context/SocketContext';
import { Panel, Button, Field, Notice, Modal } from '../components/ui';
import JobProgress from '../components/JobProgress';

const WORLD_JOB_KINDS = new Set(['backup', 'restore', 'world.import', 'world.duplicate', 'world.delete', 'world.switch', 'install']);
const KIND_STYLES = {
    manual: 'bg-cyan-500/10 text-cyan-300',
    'pre-restore': 'bg-yellow-500/10 text-yellow-300',
    'pre-delete': 'bg-red-500/10 text-red-300',
    'pre-reinstall': 'bg-purple-500/10 text-purple-300',
};

const uploadWithProgress = (url, formData, onProgress) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((100 * event.loaded) / event.total));
    xhr.onload = () => {
        let data = null;
        try {
            data = JSON.parse(xhr.responseText);
        } catch {
            data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data?.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed.'));
    xhr.send(formData);
});

const BackupTable = ({ backups, showWorld, busy, onRestore, onVerify, onDelete }) => {
    if (!backups.length) return <p className="text-sm text-slate-500">No backups yet.</p>;
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                    <tr className="text-left text-xs font-mono text-slate-500 uppercase">
                        <th className="py-2 pr-3">Created</th>
                        {showWorld && <th className="py-2 pr-3">World</th>}
                        <th className="py-2 pr-3">Kind</th>
                        <th className="py-2 pr-3">Size</th>
                        <th className="py-2 pr-3">Note</th>
                        <th className="py-2" />
                    </tr>
                </thead>
                <tbody>
                    {backups.map((backup) => (
                        <tr key={backup.id} className="border-t border-slate-800 text-slate-300">
                            <td className="py-2 pr-3 whitespace-nowrap">
                                {formatDate(backup.createdAt)}
                                {backup.hot && <span className="ml-2 text-xs text-orange-300">live</span>}
                            </td>
                            {showWorld && <td className="py-2 pr-3">{backup.worldName}</td>}
                            <td className="py-2 pr-3">
                                <span className={`px-2 py-0.5 rounded text-xs font-mono ${KIND_STYLES[backup.kind] || ''}`}>{backup.kind}</span>
                            </td>
                            <td className="py-2 pr-3 whitespace-nowrap">{formatBytes(backup.sizeBytes)}</td>
                            <td className="py-2 pr-3 text-slate-400 max-w-[12rem] truncate" title={backup.note}>{backup.note}</td>
                            <td className="py-2">
                                <div className="flex gap-1 justify-end">
                                    <Button variant="ghost" icon={RotateCcw} title="Restore" disabled={busy} onClick={() => onRestore(backup)} />
                                    <a href={`/api/backups/${backup.id}/download`} title="Download" className="inline-flex items-center px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
                                        <Download className="w-4 h-4" />
                                    </a>
                                    <Button variant="ghost" icon={ShieldCheck} title="Verify checksum" onClick={() => onVerify(backup)} />
                                    <Button variant="ghost" icon={Trash2} title="Delete" disabled={busy} onClick={() => onDelete(backup)} />
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const WorldsPage = () => {
    const { status, operation, jobs } = useSocket();
    const [data, setData] = useState(null);
    const [setups, setSetups] = useState([]);
    const [backups, setBackups] = useState([]);
    const [tab, setTab] = useState('worlds');
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [jobId, setJobId] = useState(null);
    const [dialog, setDialog] = useState(null);
    const [form, setForm] = useState({});
    const [uploadProgress, setUploadProgress] = useState(null);
    const fileInput = useRef(null);

    const busy = Boolean(operation) || uploadProgress !== null;
    const stopped = status === 'OFFLINE' || status === 'UNCONFIGURED';

    const load = useCallback(async () => {
        try {
            const [worldData, backupList, setupData] = await Promise.all([api.get('/api/worlds'), api.get('/api/backups'), api.get('/api/setups')]);
            setData(worldData);
            setSetups(setupData.setups);
            setBackups(backupList);
            setError(null);
        } catch (err) {
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Reload when a world-related job finishes.
    const finishedKey = useMemo(() => Object.values(jobs)
        .filter((job) => WORLD_JOB_KINDS.has(job.kind) && job.status !== 'running')
        .map((job) => job.id)
        .sort()
        .join(','), [jobs]);
    useEffect(() => {
        if (finishedKey) load();
    }, [finishedKey, load]);

    // retryConfirmed re-sends the request with confirmUpgrade after the admin agrees.
    const run = async (action, successMessage, retryConfirmed) => {
        setError(null);
        setNotice(null);
        try {
            const result = await action();
            if (result?.id && result?.kind) setJobId(result.id);
            else if (successMessage) setNotice(successMessage);
            setDialog(null);
            await load();
        } catch (err) {
            if (err.code === 'UPGRADE_CONFIRMATION_REQUIRED' && retryConfirmed) {
                setDialog({ type: 'upgrade', message: err.message, retry: () => run(retryConfirmed, successMessage) });
            } else {
                setError(err.message);
            }
        }
    };

    const setupLabel = (setup) => (setup ? `${setup.loader === 'fabric' ? 'Fabric' : 'Forge'} ${setup.minecraftVersion}` : 'no setup');

    const openDialog = (type, payload = {}, initialForm = {}) => {
        setForm(initialForm);
        setDialog({ type, ...payload });
    };

    const importWorld = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const formData = new FormData();
        formData.append('name', file.name.replace(/\.zip$/i, ''));
        formData.append('file', file);
        setError(null);
        setUploadProgress(0);
        try {
            const job = await uploadWithProgress('/api/worlds/import', formData, setUploadProgress);
            setJobId(job.id);
        } catch (err) {
            setError(err.message);
        } finally {
            setUploadProgress(null);
        }
    };

    const verify = async (backup) => {
        setError(null);
        try {
            const result = await api.post(`/api/backups/${backup.id}/verify`);
            setNotice(result.ok ? `Backup ${backup.id} is intact.` : `Backup ${backup.id} is CORRUPTED.`);
        } catch (err) {
            setError(err.message);
        }
    };

    const worlds = data?.worlds || [];
    const dialogWorld = dialog?.world;
    const totalBackupBytes = backups.reduce((sum, backup) => sum + (backup.sizeBytes || 0), 0);

    const actions = (
        <>
            <Button icon={Plus} onClick={() => openDialog('create', {}, { name: '', seed: '', levelType: 'default', setActive: false, setupId: setups.find((setup) => setup.active)?.id || '' })} disabled={busy}>New</Button>
            <Button variant="secondary" icon={Upload} onClick={() => fileInput.current?.click()} disabled={busy}>Import .zip</Button>
            <input ref={fileInput} type="file" accept=".zip" className="hidden" onChange={importWorld} />
        </>
    );

    return (
        <Panel title="Worlds & backups" icon={Globe} actions={actions} className="h-full">
            <div className="space-y-4">
                {data && !data.installed && (
                    <Notice tone="warn">Minecraft is not installed yet. <Link to="/server" className="underline">Install the server</Link> first.</Notice>
                )}
                {data?.legacyWorld && (
                    <Notice tone="info">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span>An unmanaged world was found at server\world.</span>
                            <Button icon={FolderInput} disabled={!stopped || busy} onClick={() => run(() => api.post('/api/worlds/adopt', { name: 'World' }), 'Existing world adopted.')}>
                                Adopt it
                            </Button>
                        </div>
                    </Notice>
                )}
                {!stopped && <Notice tone="info">The server is {status}. Switching, restoring over the active world, and deleting need it stopped.</Notice>}
                {error && <Notice tone="error">{error}</Notice>}
                {notice && <Notice tone="success">{notice}</Notice>}
                {uploadProgress !== null && <Notice tone="info">Uploading... {uploadProgress}%</Notice>}
                {jobId && <JobProgress jobId={jobId} />}

                <div className="flex gap-2 bg-slate-950 p-1 rounded-lg w-fit">
                    {[['worlds', `Worlds (${worlds.length})`], ['backups', `All backups (${backups.length})`]].map(([key, label]) => (
                        <button key={key} type="button" onClick={() => setTab(key)}
                            className={`px-3 py-1 text-xs font-bold rounded ${tab === key ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}>
                            {label}
                        </button>
                    ))}
                </div>

                {tab === 'worlds' && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                        {!data && <p className="text-slate-500">Loading...</p>}
                        {data && !worlds.length && <p className="text-slate-500">No worlds yet.</p>}
                        {worlds.map((world) => {
                            const worldBackups = backups.filter((backup) => backup.worldId === world.id);
                            const liveActive = world.active && !stopped;
                            return (
                                <div key={world.id} className={`bg-slate-950 border rounded-lg p-4 space-y-3 ${world.active ? 'border-cyan-500/50' : 'border-slate-800'}`}>
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="font-bold text-white truncate">{world.name}</div>
                                            <div className="text-xs font-mono text-slate-500">{world.id}</div>
                                        </div>
                                        {world.active && <span className="px-2 py-0.5 rounded text-xs font-bold bg-cyan-500/20 text-cyan-300">ACTIVE</span>}
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-slate-400">
                                        <span>Size: {world.generated ? formatBytes(world.sizeBytes) : 'not generated'}</span>
                                        <span>Backups: {worldBackups.length}</span>
                                        <span>Created: {new Date(world.createdAt).toLocaleDateString()}</span>
                                        <span>Played: {world.lastPlayedAt ? new Date(world.lastPlayedAt).toLocaleDateString() : '—'}</span>
                                        <span className="col-span-2">
                                            Runs on: <span className="text-cyan-300 font-mono">{setupLabel(world.setup)}</span>
                                            {world.savedVersion && world.savedVersion !== world.setup?.minecraftVersion && (
                                                <span className="text-yellow-300"> · saved with {world.savedVersion}</span>
                                            )}
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {!world.active && (
                                            <Button icon={Play} disabled={!stopped || busy} title={stopped ? 'Make this the active world' : 'Stop the server first'}
                                                onClick={() => run(
                                                    () => api.post(`/api/worlds/${world.id}/activate`),
                                                    `"${world.name}" is now the active world.`,
                                                    () => api.post(`/api/worlds/${world.id}/activate`, { confirmUpgrade: true }),
                                                )}>
                                                Activate
                                            </Button>
                                        )}
                                        <Button variant="secondary" icon={Archive} disabled={busy || !world.generated}
                                            onClick={() => openDialog('backup', { world }, { note: '' })}>
                                            Backup
                                        </Button>
                                        <Button variant="secondary" disabled={!worldBackups.length} onClick={() => openDialog('backups', { world })}>
                                            Backups
                                        </Button>
                                        {setups.length > 1 && (
                                            <Button variant="secondary" disabled={busy || liveActive} title="Run this world on another version"
                                                onClick={() => openDialog('version', { world }, { setupId: world.setup?.id || '' })}>
                                                Version
                                            </Button>
                                        )}
                                        <Button variant="ghost" icon={Pencil} title="Rename" onClick={() => openDialog('rename', { world }, { name: world.name })} />
                                        <Button variant="ghost" icon={Copy} title="Duplicate" disabled={busy || liveActive || !world.generated}
                                            onClick={() => openDialog('duplicate', { world }, { name: `${world.name} (copy)` })} />
                                        {world.generated && !liveActive && (
                                            <a href={`/api/worlds/${world.id}/download`} title="Download as .zip" className="inline-flex items-center px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800">
                                                <Download className="w-4 h-4" />
                                            </a>
                                        )}
                                        <Button variant="ghost" icon={Trash2} title={world.active ? 'Activate another world first' : 'Delete'} disabled={busy || world.active}
                                            onClick={() => openDialog('delete', { world }, { confirm: '' })} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {tab === 'backups' && (
                    <div className="space-y-2">
                        <p className="text-xs text-slate-500">Total: {formatBytes(totalBackupBytes)}. Manual backups are kept until you delete them; safety snapshots keep the latest 5 per world.</p>
                        <BackupTable backups={backups} showWorld busy={busy}
                            onRestore={(backup) => openDialog('restore', { backup }, { mode: 'replace', newName: `${backup.worldName} (restored)`, confirm: '' })}
                            onVerify={verify}
                            onDelete={(backup) => openDialog('deleteBackup', { backup })} />
                    </div>
                )}
            </div>

            {dialog?.type === 'create' && (
                <Modal title="New world" onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button disabled={!form.name?.trim()} onClick={() => run(() => api.post('/api/worlds', form), 'World created. It is generated on the next start.')}>Create</Button>
                </>}>
                    <Field label="Name"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
                    <Field label="Seed" hint="Optional. Leave empty for a random seed.">
                        <input className={inputClass} value={form.seed} onChange={(e) => setForm({ ...form, seed: e.target.value })} />
                    </Field>
                    {setups.length > 1 && (
                        <Field label="Version (setup)">
                            <select className={inputClass} value={form.setupId || ''} onChange={(e) => setForm({ ...form, setupId: e.target.value })}>
                                {setups.map((setup) => <option key={setup.id} value={setup.id}>{setupLabel(setup)}{setup.active ? ' (active)' : ''}</option>)}
                            </select>
                        </Field>
                    )}
                    <Field label="World type">
                        <select className={inputClass} value={form.levelType} onChange={(e) => setForm({ ...form, levelType: e.target.value })}>
                            <option value="default">Default</option>
                            <option value="flat">Superflat</option>
                            <option value="amplified">Amplified</option>
                            <option value="large_biomes">Large biomes</option>
                        </select>
                    </Field>
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                        <input type="checkbox" checked={form.setActive} disabled={!stopped} onChange={(e) => setForm({ ...form, setActive: e.target.checked })} />
                        Make it the active world {stopped ? '' : '(stop the server first)'}
                    </label>
                    <p className="text-xs text-slate-500">Mods and configuration are shared by all worlds.</p>
                </Modal>
            )}

            {dialog?.type === 'upgrade' && (
                <Modal title="Upgrade world?" onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button onClick={dialog.retry}>Back up and upgrade</Button>
                </>}>
                    <Notice tone="warn">{dialog.message}</Notice>
                    <p className="text-sm text-slate-400">The backup (kind "pre-upgrade") lets you restore the old version later.</p>
                </Modal>
            )}

            {dialog?.type === 'version' && (
                <Modal title={`Version for ${dialogWorld.name}`} onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button disabled={!form.setupId || form.setupId === dialogWorld.setup?.id}
                        onClick={() => run(
                            () => api.patch(`/api/worlds/${dialogWorld.id}`, { setupId: form.setupId }),
                            'World moved to the new version.',
                            () => api.patch(`/api/worlds/${dialogWorld.id}`, { setupId: form.setupId, confirmUpgrade: true }),
                        )}>
                        Move
                    </Button>
                </>}>
                    <Field label="Run this world on">
                        <select className={inputClass} value={form.setupId} onChange={(e) => setForm({ ...form, setupId: e.target.value })}>
                            {setups.map((setup) => <option key={setup.id} value={setup.id}>{setupLabel(setup)}{setup.active ? ' (active)' : ''}</option>)}
                        </select>
                    </Field>
                    <p className="text-xs text-slate-500">Moving to a newer version upgrades the world the next time it runs (a backup is taken first). Older versions are refused.</p>
                </Modal>
            )}

            {dialog?.type === 'rename' && (
                <Modal title={`Rename ${dialogWorld.name}`} onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button disabled={!form.name?.trim()} onClick={() => run(() => api.patch(`/api/worlds/${dialogWorld.id}`, { name: form.name }))}>Save</Button>
                </>}>
                    <Field label="Name"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
                </Modal>
            )}

            {dialog?.type === 'duplicate' && (
                <Modal title={`Duplicate ${dialogWorld.name}`} onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button disabled={!form.name?.trim()} onClick={() => run(() => api.post(`/api/worlds/${dialogWorld.id}/duplicate`, { name: form.name }))}>Duplicate</Button>
                </>}>
                    <Field label="New name"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
                </Modal>
            )}

            {dialog?.type === 'backup' && (
                <Modal title={`Back up ${dialogWorld.name}`} onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button icon={Archive} onClick={() => run(() => api.post('/api/backups', { worldId: dialogWorld.id, note: form.note }))}>Back up now</Button>
                </>}>
                    {dialogWorld.active && !stopped && (
                        <Notice tone="info">The server is running. Autosave is paused while the backup is written; players can keep playing.</Notice>
                    )}
                    <Field label="Note" hint="Optional, e.g. 'before the nether update'.">
                        <input className={inputClass} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} autoFocus />
                    </Field>
                </Modal>
            )}

            {dialog?.type === 'backups' && (
                <Modal title={`Backups of ${dialogWorld.name}`} onClose={() => setDialog(null)}>
                    <BackupTable backups={backups.filter((backup) => backup.worldId === dialogWorld.id)} busy={busy}
                        onRestore={(backup) => openDialog('restore', { backup }, { mode: 'replace', newName: `${backup.worldName} (restored)`, confirm: '' })}
                        onVerify={verify}
                        onDelete={(backup) => openDialog('deleteBackup', { backup })} />
                </Modal>
            )}

            {dialog?.type === 'restore' && (() => {
                const { backup } = dialog;
                const target = worlds.find((world) => world.id === backup.worldId);
                const replaceBlocked = !target || (target.active && !stopped);
                const mode = replaceBlocked ? 'new' : form.mode;
                return (
                    <Modal title={`Restore backup from ${formatDate(backup.createdAt)}`} onClose={() => setDialog(null)} footer={<>
                        <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                        <Button variant={mode === 'replace' ? 'danger' : 'primary'} icon={RotateCcw}
                            disabled={mode === 'replace' ? form.confirm !== backup.worldId : !form.newName?.trim()}
                            onClick={() => run(() => api.post(`/api/backups/${backup.id}/restore`, { mode, newName: form.newName }))}>
                            Restore
                        </Button>
                    </>}>
                        <label className="flex items-start gap-2 text-sm text-slate-300">
                            <input type="radio" className="mt-1" checked={mode === 'replace'} disabled={replaceBlocked} onChange={() => setForm({ ...form, mode: 'replace' })} />
                            <span>
                                Replace "{backup.worldName}" with this backup.
                                <span className="block text-xs text-slate-500">
                                    {!target ? 'That world no longer exists.' : replaceBlocked ? 'Stop the server first.' : 'A safety snapshot of the current state is taken first.'}
                                </span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2 text-sm text-slate-300">
                            <input type="radio" className="mt-1" checked={mode === 'new'} onChange={() => setForm({ ...form, mode: 'new' })} />
                            Restore as a new world
                        </label>
                        {mode === 'new' && (
                            <Field label="New world name"><input className={inputClass} value={form.newName} onChange={(e) => setForm({ ...form, newName: e.target.value })} /></Field>
                        )}
                        {mode === 'replace' && (
                            <Field label={`Type ${backup.worldId} to confirm`}>
                                <input className={inputClass} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
                            </Field>
                        )}
                    </Modal>
                );
            })()}

            {dialog?.type === 'delete' && (
                <Modal title={`Delete ${dialogWorld.name}`} onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button variant="danger" icon={Trash2} disabled={form.confirm !== dialogWorld.id}
                        onClick={() => run(() => api.delete(`/api/worlds/${dialogWorld.id}?confirm=${encodeURIComponent(dialogWorld.id)}`))}>
                        Delete world
                    </Button>
                </>}>
                    <Notice tone="warn">A final backup ("pre-delete") is taken before the files are removed. Existing backups are kept.</Notice>
                    <Field label={`Type ${dialogWorld.id} to confirm`}>
                        <input className={inputClass} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} autoFocus />
                    </Field>
                </Modal>
            )}

            {dialog?.type === 'deleteBackup' && (
                <Modal title="Delete backup" onClose={() => setDialog(null)} footer={<>
                    <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
                    <Button variant="danger" icon={Trash2} onClick={() => run(() => api.delete(`/api/backups/${dialog.backup.id}`), 'Backup deleted.')}>Delete</Button>
                </>}>
                    <p className="text-sm text-slate-300">Delete the {dialog.backup.kind} backup of "{dialog.backup.worldName}" from {formatDate(dialog.backup.createdAt)} ({formatBytes(dialog.backup.sizeBytes)})? This cannot be undone.</p>
                </Modal>
            )}
        </Panel>
    );
};

export default WorldsPage;

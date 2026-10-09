import React, { useCallback, useEffect, useState } from 'react';
import { MessageCircle, Save, RefreshCw, Link2, Copy } from 'lucide-react';
import { api } from '../lib/api';
import { inputClass, formatDate } from '../lib/format';
import { Panel, Button, Field, Notice } from '../components/ui';

const DiscordPage = () => {
    const [view, setView] = useState(null);
    const [form, setForm] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [working, setWorking] = useState(false);

    const load = useCallback(async () => {
        try {
            const data = await api.get('/api/discord');
            setView(data);
            setForm({
                webhookUrl: '',
                baseUrl: data.baseUrl || data.suggested?.baseUrl || '',
                gameAddress: data.gameAddress || data.suggested?.gameAddress || '',
                inviteUrl: data.inviteUrl,
                serverName: data.serverName,
                postTitle: data.postTitle,
                existingPost: '',
                enabled: data.enabled || !data.webhookConfigured,
            });
        } catch (err) {
            setError(err.message);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const act = async (action, message) => {
        setWorking(true);
        setError(null);
        setNotice(null);
        try {
            setView({ ...view, ...(await action()) });
            if (message) setNotice(message);
        } catch (err) {
            setError(err.message);
        } finally {
            setWorking(false);
        }
    };

    const save = () => act(async () => {
        const saved = await api.put('/api/discord', form);
        setForm({ ...form, webhookUrl: '', existingPost: '' });
        return saved;
    }, 'Saved. Discord updates within a few seconds.');

    if (!form) {
        return (
            <Panel title="Discord" icon={MessageCircle} className="h-full">
                {error ? <Notice tone="error">{error}</Notice> : <p className="text-slate-500">Loading...</p>}
            </Panel>
        );
    }

    const field = (key) => ({ value: form[key], onChange: (e) => setForm({ ...form, [key]: e.target.value }) });

    return (
        <Panel title="Discord" icon={MessageCircle} className="h-full">
            <div className="space-y-5 max-w-3xl">
                <p className="text-sm text-slate-400">
                    MC Manager keeps a player guide (Tailscale, Fabric, mods, address) and a server card (status, world, mod list,
                    one-click mod download) up to date, and posts a short notice when mods change. In a forum channel it creates one
                    post: the guide opens it and the card and notices live inside it. In a text channel, pin both messages.
                </p>
                {error && <Notice tone="error">{error}</Notice>}
                {notice && <Notice tone="success">{notice}</Notice>}
                {view.lastError && <Notice tone="warn">Last sync failed: {view.lastError}</Notice>}

                <Field label="Webhook URL" hint={view.webhookConfigured
                    ? `Configured (${view.webhookUrl}). Paste a new one to replace it.`
                    : 'Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.'}>
                    <input className={inputClass} type="password" autoComplete="off" placeholder="https://discord.com/api/webhooks/..." {...field('webhookUrl')} />
                </Field>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Server name"><input className={inputClass} {...field('serverName')} /></Field>
                    <Field label="Game address" hint="What players type in Multiplayer.">
                        <input className={inputClass} placeholder="100.x.y.z:25565" {...field('gameAddress')} />
                    </Field>
                    <Field label="Manager address" hint="Used for the download link; must be reachable over Tailscale.">
                        <input className={inputClass} placeholder="http://100.x.y.z:3000" {...field('baseUrl')} />
                    </Field>
                    <Field label="Tailscale invite link" hint="Optional. Tailscale admin console → Users → Invite.">
                        <input className={inputClass} placeholder="https://login.tailscale.com/..." {...field('inviteUrl')} />
                    </Field>
                    <Field label="Forum post title" hint="Used when a new forum post is created.">
                        <input className={inputClass} placeholder={`Minecraft — ${form.serverName || 'server'}`} {...field('postTitle')} />
                    </Field>
                    <Field label="Use an existing forum post" hint="Optional. Right-click a post → Copy Link.">
                        <input className={inputClass} placeholder="https://discord.com/channels/.../..." {...field('existingPost')} />
                    </Field>
                </div>
                {view.postUrl && (
                    <p className="text-sm text-slate-400">
                        Forum post: <a href={view.postUrl} target="_blank" rel="noreferrer" className="text-cyan-400 underline">open in Discord</a>
                    </p>
                )}
                <label className="flex items-center gap-2 text-sm text-slate-300">
                    <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                    Keep Discord in sync automatically
                </label>

                <div className="flex flex-wrap gap-2">
                    <Button icon={Save} disabled={working} onClick={save}>Save</Button>
                    <Button variant="secondary" icon={RefreshCw} disabled={working || !view.webhookConfigured}
                        onClick={() => act(() => api.post('/api/discord/sync'), 'Discord is up to date.')}>
                        Sync now
                    </Button>
                    <Button variant="secondary" disabled={working || !view.webhookConfigured}
                        onClick={() => act(() => api.post('/api/discord/sync', { force: true }), 'Messages refreshed.')}>
                        Refresh messages
                    </Button>
                </div>

                {view.packUrl && (
                    <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-2">
                        <div className="text-xs font-mono text-slate-500 uppercase">Mod pack download link</div>
                        <div className="text-sm font-mono text-cyan-300 break-all">{view.packUrl}</div>
                        <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" icon={Copy} onClick={() => navigator.clipboard?.writeText(view.packUrl)}>Copy</Button>
                            <Button variant="danger" icon={Link2} disabled={working}
                                onClick={() => act(() => api.post('/api/discord/regenerate-link'), 'New link created; the old one stopped working.')}>
                                Regenerate link
                            </Button>
                        </div>
                        <p className="text-xs text-slate-500">Anyone with this link (on your tailnet) can download the mods. Regenerate it if it leaks.</p>
                    </div>
                )}
                <p className="text-xs text-slate-500">Last synced: {formatDate(view.lastSyncAt)}</p>
            </div>
        </Panel>
    );
};

export default DiscordPage;

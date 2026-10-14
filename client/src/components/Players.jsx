import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, Shield, ShieldOff, UserX, Ban, Undo2, UserPlus, Check, X, ListChecks } from 'lucide-react';
import { useSocket } from '../context/SocketContext';
import { api } from '../lib/api';
import { inputClass } from '../lib/format';
import { Button, Modal, Notice } from './ui';

const TABS = [
    { id: 'online', label: 'Online' },
    { id: 'all', label: 'All players' },
    { id: 'requests', label: 'Requests' },
    { id: 'banned', label: 'Banned' },
];

const ago = (ms) => {
    if (!ms) return 'never';
    const minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
    return new Date(ms).toLocaleDateString();
};
const hours = (ms) => (ms ? (ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} h` : `${Math.round(ms / 60000)} min`) : '—');
const hue = (name) => [...name].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7);

const Badge = ({ tone, children }) => (
    <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${tone}`}>{children}</span>
);

const IconButton = ({ icon, title, tone, ...props }) => (
    <button type="button" title={title} {...props} className={`p-1.5 rounded ${tone} disabled:opacity-30`}>
        {React.createElement(icon, { className: "w-3.5 h-3.5" })}
    </button>
);

const Players = () => {
    const { socket, players: live } = useSocket();
    const [data, setData] = useState(null);
    const [tab, setTab] = useState('online');
    const [newName, setNewName] = useState('');
    const [confirm, setConfirm] = useState(null);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);

    const load = useCallback(() => {
        api.get('/api/roster').then(setData).catch((err) => setError(err.message));
    }, []);
    // Reload when someone joins or leaves, or a join request arrives.
    const liveKey = live.active.map((p) => p.name).join(',');
    useEffect(() => { load(); }, [load, liveKey]);
    useEffect(() => {
        if (!socket) return undefined;
        socket.on('roster_changed', load);
        return () => socket.off('roster_changed', load);
    }, [socket, load]);

    const act = async (action, name) => {
        setError(null);
        setConfirm(null);
        try {
            const result = await api.post('/api/roster/action', { action, name });
            setData(result);
            setMessage(result.message || null);
        } catch (err) {
            setError(err.message);
        }
    };

    const toggleWhitelist = async () => {
        setError(null);
        try {
            setData(await api.put('/api/roster/whitelist', { enabled: !data.whitelistEnabled }));
        } catch (err) {
            setError(err.message);
        }
    };

    const rows = useMemo(() => {
        if (!data) return [];
        if (tab === 'online') return data.players.filter((p) => p.online);
        if (tab === 'banned') return data.players.filter((p) => p.banned);
        return data.players;
    }, [data, tab]);

    if (!data) return <div className="text-slate-500 font-mono text-sm">{error || 'Loading…'}</div>;
    const counts = { online: data.players.filter((p) => p.online).length, all: data.players.length, requests: data.requests.length, banned: data.players.filter((p) => p.banned).length };

    return (
        <div className="h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col">
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex flex-wrap items-center gap-2">
                <Users className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-mono text-slate-400 uppercase tracking-widest mr-auto">Personnel</span>
                <div className="flex gap-1 bg-slate-900 p-1 rounded-lg">
                    {TABS.map((entry) => (
                        <button key={entry.id} type="button" onClick={() => setTab(entry.id)}
                            className={`px-2.5 py-1 text-[11px] font-bold rounded uppercase ${tab === entry.id ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}>
                            {entry.label} ({counts[entry.id]})
                        </button>
                    ))}
                </div>
            </div>

            <div className="p-4 md:p-6 overflow-auto space-y-4">
                {error && <Notice tone="error">{error}</Notice>}
                {message && <Notice tone="info">{message}</Notice>}

                <div className="flex flex-wrap items-center gap-3 bg-slate-950 border border-slate-800 rounded-lg p-3">
                    <ListChecks className={`w-5 h-5 ${data.whitelistEnabled ? 'text-green-400' : 'text-slate-500'}`} />
                    <div className="mr-auto">
                        <div className="text-sm text-slate-200">Whitelist {data.whitelistEnabled ? 'on' : 'off'}</div>
                        <div className="text-xs text-slate-500">
                            {data.whitelistEnabled ? 'Only listed players can join; refused names show up under Requests.' : 'Anyone with the address can join.'}
                            {data.offlineMode && ' Offline mode: players are matched by name.'}
                        </div>
                    </div>
                    <Button variant={data.whitelistEnabled ? 'secondary' : 'primary'} onClick={toggleWhitelist}>
                        {data.whitelistEnabled ? 'Turn off' : 'Turn on'}
                    </Button>
                    <form className="flex gap-2 w-full md:w-auto" onSubmit={(e) => { e.preventDefault(); if (newName.trim()) { act('whitelist-add', newName.trim()); setNewName(''); } }}>
                        <input className={`${inputClass} md:!w-44`} value={newName} maxLength={16} placeholder="Player name" onChange={(e) => setNewName(e.target.value)} />
                        <Button type="submit" variant="secondary" icon={UserPlus}>Whitelist</Button>
                    </form>
                </div>

                {tab === 'requests' ? (
                    data.requests.length ? (
                        <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg">
                            {data.requests.map((request) => (
                                <div key={request.name} className="flex items-center gap-3 px-3 py-2">
                                    <span className="font-medium text-slate-200">{request.name}</span>
                                    <span className="text-xs text-slate-500">tried {request.count}× · last {ago(request.lastAt)}{request.ip ? ` · ${request.ip}` : ''}</span>
                                    <div className="ml-auto flex gap-2">
                                        <Button icon={Check} onClick={() => act('approve', request.name)}>Approve</Button>
                                        <Button variant="ghost" icon={X} onClick={() => act('deny', request.name)}>Dismiss</Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : <div className="text-sm text-slate-500 text-center py-8">No join requests. With the whitelist on, anyone who is refused appears here.</div>
                ) : rows.length ? (
                    <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg">
                        {rows.map((player) => (
                            <div key={player.name} className="flex flex-wrap items-center gap-3 px-3 py-2">
                                <div className="w-8 h-8 rounded-md flex items-center justify-center text-sm font-bold relative"
                                    style={{ background: `hsl(${hue(player.name)} 45% 25%)`, color: `hsl(${hue(player.name)} 80% 80%)` }}>
                                    {player.name[0].toUpperCase()}
                                    {player.online && <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-green-500 border-2 border-slate-900" />}
                                </div>
                                <div className="min-w-0 mr-auto">
                                    <div className="flex items-center gap-1.5">
                                        <span className="font-medium text-slate-200">{player.name}</span>
                                        {player.op && <Badge tone="bg-green-500/10 text-green-300">op</Badge>}
                                        {player.whitelisted && <Badge tone="bg-cyan-500/10 text-cyan-300">whitelisted</Badge>}
                                        {player.banned && <Badge tone="bg-red-500/10 text-red-300">banned</Badge>}
                                    </div>
                                    <div className="text-xs text-slate-500">
                                        {player.online ? 'online now' : `seen ${ago(player.lastSeen)}`} · played {hours(player.playtimeMs)}
                                    </div>
                                </div>
                                <div className="flex gap-1">
                                    <IconButton icon={player.whitelisted ? X : UserPlus} title={player.whitelisted ? 'Remove from whitelist' : 'Whitelist'} tone="bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
                                        onClick={() => act(player.whitelisted ? 'whitelist-remove' : 'whitelist-add', player.name)} />
                                    <IconButton icon={player.op ? ShieldOff : Shield} title={player.op ? 'Revoke operator' : 'Make operator'} tone="bg-green-500/10 text-green-300 hover:bg-green-500/20"
                                        onClick={() => act(player.op ? 'deop' : 'op', player.name)} />
                                    <IconButton icon={UserX} title="Kick" tone="bg-orange-500/10 text-orange-300 hover:bg-orange-500/20" disabled={!player.online}
                                        onClick={() => setConfirm({ action: 'kick', name: player.name })} />
                                    {player.banned
                                        ? <IconButton icon={Undo2} title="Unban" tone="bg-slate-800 text-slate-300 hover:bg-slate-700" onClick={() => act('pardon', player.name)} />
                                        : <IconButton icon={Ban} title="Ban" tone="bg-red-500/10 text-red-300 hover:bg-red-500/20" onClick={() => setConfirm({ action: 'ban', name: player.name })} />}
                                </div>
                            </div>
                        ))}
                    </div>
                ) : <div className="text-sm text-slate-500 text-center py-8">{tab === 'online' ? 'Nobody is online.' : 'No players yet.'}</div>}
            </div>

            {confirm && (
                <Modal title={`${confirm.action === 'ban' ? 'Ban' : 'Kick'} ${confirm.name}?`} onClose={() => setConfirm(null)} footer={<>
                    <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                    <Button variant="danger" onClick={() => act(confirm.action, confirm.name)}>{confirm.action === 'ban' ? 'Ban' : 'Kick'}</Button>
                </>}>
                    <p className="text-sm text-slate-400">
                        {confirm.action === 'ban' ? 'They will not be able to join until unbanned.' : 'They are disconnected but can rejoin.'}
                    </p>
                </Modal>
            )}
        </div>
    );
};

export default Players;

import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { api } from '../lib/api';
import {
    Terminal,
    Map as MapIcon,
    Users,
    MessageSquare,
    LogOut,
    Server,
    Activity,
    Settings as SettingsIcon,
    Power,
    Menu,
    X,
    Wifi,
    HardDrive,
    Globe,
    Package,
    MessageCircle,
    Gamepad2,
} from 'lucide-react';

const NAV = [
    {
        group: 'Play',
        items: [
            { path: '/', icon: Terminal, label: 'Console', roles: ['admin'] },
            { path: '/controls', icon: Power, label: 'Controls', roles: ['user'] },
            { path: '/chat', icon: MessageSquare, label: 'Comms', roles: ['admin'] },
            { path: '/players', icon: Users, label: 'Personnel', roles: ['admin'] },
            { path: '/map', icon: MapIcon, label: 'Surveillance', roles: ['admin', 'user'] },
        ],
    },
    {
        group: 'Manage',
        items: [
            { path: '/server', icon: HardDrive, label: 'Server', roles: ['admin'] },
            { path: '/worlds', icon: Globe, label: 'Worlds', roles: ['admin'] },
            { path: '/mods', icon: Package, label: 'Mods', roles: ['admin'] },
            { path: '/game-sync', icon: Gamepad2, label: 'Game Sync', roles: ['admin'] },
            { path: '/discord', icon: MessageCircle, label: 'Discord', roles: ['admin'] },
        ],
    },
    {
        group: 'System',
        items: [
            { path: '/stats', icon: Activity, label: 'System', roles: ['admin'] },
            { path: '/settings', icon: SettingsIcon, label: 'Config', roles: ['admin'] },
            { path: '/ping', icon: Wifi, label: 'Ping', roles: ['admin', 'user'] },
        ],
    },
];

const STATUS_TONE = {
    ONLINE: { dot: 'bg-green-500 animate-pulse', text: 'text-green-400' },
    STARTING: { dot: 'bg-yellow-500 animate-pulse', text: 'text-yellow-400' },
    STOPPING: { dot: 'bg-yellow-500 animate-pulse', text: 'text-yellow-400' },
    UNCONFIGURED: { dot: 'bg-yellow-500', text: 'text-yellow-400' },
    OFFLINE: { dot: 'bg-slate-500', text: 'text-slate-400' },
};

const Dashboard = () => {
    const { user, logout } = useAuth();
    const location = useLocation();
    const { status: serverStatus, connected, startError, clearStartError, operation, players } = useSocket();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [summary, setSummary] = useState(null);
    const errorMsg = startError?.message;
    const tone = STATUS_TONE[serverStatus] || STATUS_TONE.OFFLINE;

    // Global errors (like start failure) clear after 10s
    useEffect(() => {
        if (!startError) return;
        const timer = setTimeout(clearStartError, 10000);
        return () => clearTimeout(timer);
    }, [startError, clearStartError]);

    // The active world and version only change with the status or an operation.
    useEffect(() => {
        api.get('/api/status').then(setSummary).catch(() => {});
    }, [serverStatus, operation]);

    const groups = NAV
        .map((group) => ({ ...group, items: group.items.filter((item) => item.roles.includes(user?.role)) }))
        .filter((group) => group.items.length);
    const current = groups.flatMap((group) => group.items).find((item) => item.path === location.pathname);
    const playerCount = user?.role === 'admin' ? players.active.length : summary?.players;

    return (
        <div className="flex h-screen bg-slate-950 text-slate-200 font-sans overflow-hidden">
            {/* Mobile Header */}
            <div className="md:hidden fixed top-0 left-0 right-0 h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 z-50">
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`h-2 w-2 rounded-full ${tone.dot}`} />
                    <span className="font-bold text-white tracking-tight truncate">{current?.label || 'CR INC.'}</span>
                </div>
                <button onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)} className="p-2 text-slate-400 hover:text-white">
                    {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                </button>
            </div>

            {isMobileMenuOpen && (
                <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setIsMobileMenuOpen(false)} />
            )}

            {/* Sidebar */}
            <div className={`
                fixed inset-y-0 left-0 z-50 w-60 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 ease-in-out md:translate-x-0 md:static md:inset-auto
                ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
            `}>
                <div className="p-5 border-b border-slate-800 hidden md:block">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-cyan-500/10 rounded-lg">
                            <Server className="w-5 h-5 text-cyan-400" />
                        </div>
                        <div>
                            <h1 className="font-bold text-white tracking-tight text-sm">CLOSED ROOM</h1>
                            <p className="text-[10px] text-slate-500 tracking-widest">INC. MANAGER</p>
                        </div>
                    </div>
                </div>

                <nav className="flex-1 p-3 mt-14 md:mt-0 overflow-y-auto space-y-4">
                    {groups.map((group) => (
                        <div key={group.group}>
                            <div className="px-3 mb-1 text-[10px] font-mono uppercase tracking-widest text-slate-600">{group.group}</div>
                            <div className="space-y-0.5">
                                {group.items.map((item) => {
                                    const Icon = item.icon;
                                    const isActive = location.pathname === item.path;
                                    return (
                                        <Link
                                            key={item.path}
                                            to={item.path}
                                            onClick={() => setIsMobileMenuOpen(false)}
                                            className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors group ${isActive
                                                ? 'bg-cyan-500/10 text-cyan-300'
                                                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}
                                        >
                                            <Icon className={`w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-slate-500 group-hover:text-slate-300'}`} />
                                            <span className="text-sm">{item.label}</span>
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    ))}
                </nav>

                <div className="p-3 border-t border-slate-800 space-y-2">
                    <div className="bg-slate-950 rounded-lg p-3 border border-slate-800 text-xs space-y-1">
                        <div className={`flex items-center gap-2 font-mono ${tone.text}`}>
                            <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
                            {serverStatus}
                            {serverStatus === 'ONLINE' && playerCount !== undefined && <span className="text-slate-500 ml-auto">{playerCount} online</span>}
                        </div>
                        {summary?.world && <div className="text-slate-400 truncate" title={summary.world}>{summary.world}</div>}
                        {summary?.version && <div className="text-slate-600 font-mono">{summary.version}</div>}
                    </div>
                    <button
                        onClick={logout}
                        className="flex items-center gap-3 px-3 py-2 w-full rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors text-sm"
                    >
                        <LogOut className="w-4 h-4" />
                        Logout
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden bg-slate-950 relative w-full">
                <header className="hidden md:flex h-14 bg-slate-900/50 border-b border-slate-800 items-center justify-between px-6 gap-4">
                    <h2 className="text-base font-medium text-white tracking-wide">{current?.label || 'Dashboard'}</h2>
                    <div className="flex items-center gap-4 text-xs font-mono min-w-0">
                        {summary?.world && (
                            <span className="text-slate-400 truncate">
                                {summary.world}<span className="text-slate-600"> · {summary.version}</span>
                            </span>
                        )}
                        {operation && <span className="text-yellow-400 truncate">{operation.kind}…</span>}
                        <span className={`flex items-center gap-2 ${tone.text}`}>
                            <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
                            {serverStatus}{serverStatus === 'ONLINE' && playerCount !== undefined ? ` · ${playerCount} online` : ''}
                        </span>
                        {!connected && <span className="text-red-400">reconnecting…</span>}
                    </div>
                </header>

                <main className="flex-1 overflow-auto p-3 md:p-6 relative mt-14 md:mt-0">
                    <Outlet />
                </main>
            </div>

            {errorMsg && (
                <div className="fixed bottom-4 right-4 left-4 md:left-auto z-50 bg-red-500/90 text-white px-5 py-3 rounded-lg shadow-2xl border border-red-400">
                    <div className="flex items-center gap-3">
                        <Activity className="w-5 h-5 shrink-0" />
                        <p className="font-mono text-sm flex-1">{errorMsg}</p>
                        <button onClick={clearStartError} className="hover:text-red-200"><X className="w-5 h-5" /></button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;

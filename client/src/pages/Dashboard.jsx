import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
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
    Package
} from 'lucide-react';

const Dashboard = () => {
    const { user, logout } = useAuth();
    const location = useLocation();
    const { status: serverStatus, connected, startError, clearStartError } = useSocket();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const errorMsg = startError?.message;

    // Global errors (like start failure) clear after 10s
    useEffect(() => {
        if (!startError) return;
        const timer = setTimeout(clearStartError, 10000);
        return () => clearTimeout(timer);
    }, [startError, clearStartError]);

    const allNavItems = [
        { path: '/', icon: Terminal, label: 'Console', roles: ['admin'] },
        { path: '/controls', icon: Power, label: 'Controls', roles: ['user'] },
        { path: '/chat', icon: MessageSquare, label: 'Comms', roles: ['admin'] },
        { path: '/players', icon: Users, label: 'Personnel', roles: ['admin'] },
        { path: '/map', icon: MapIcon, label: 'Surveillance', roles: ['admin', 'user'] },
        { path: '/stats', icon: Activity, label: 'System', roles: ['admin'] },
        { path: '/ping', icon: Wifi, label: 'Ping', roles: ['admin', 'user'] },
        { path: '/server', icon: HardDrive, label: 'Server', roles: ['admin'] },
        { path: '/worlds', icon: Globe, label: 'Worlds', roles: ['admin'] },
        { path: '/mods', icon: Package, label: 'Mods', roles: ['admin'] },
        { path: '/settings', icon: SettingsIcon, label: 'Config', roles: ['admin'] },
    ];

    const navItems = allNavItems.filter(item => item.roles.includes(user?.role));

    const toggleMobileMenu = () => setIsMobileMenuOpen(!isMobileMenuOpen);

    return (
        <div className="flex h-screen bg-slate-950 text-slate-200 font-sans overflow-hidden">
            {/* Mobile Header */}
            <div className="md:hidden fixed top-0 left-0 right-0 h-16 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 z-50">
                <div className="flex items-center gap-3">
                    <div className="p-1.5 bg-cyan-500/10 rounded-lg">
                        <Server className="w-5 h-5 text-cyan-400" />
                    </div>
                    <span className="font-bold text-white tracking-tight">CR INC.</span>
                </div>
                <button onClick={toggleMobileMenu} className="p-2 text-slate-400 hover:text-white">
                    {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                </button>
            </div>

            {/* Sidebar Overlay */}
            {isMobileMenuOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-40 md:hidden"
                    onClick={() => setIsMobileMenuOpen(false)}
                />
            )}

            {/* Sidebar */}
            <div className={`
                fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 border-r border-slate-800 flex flex-col transition-transform duration-300 ease-in-out md:translate-x-0 md:static md:inset-auto
                ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
            `}>
                <div className="p-6 border-b border-slate-800 hidden md:block">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-cyan-500/10 rounded-lg">
                            <Server className="w-6 h-6 text-cyan-400" />
                        </div>
                        <div>
                            <h1 className="font-bold text-white tracking-tight">CLOSED ROOM</h1>
                            <p className="text-xs text-slate-500 tracking-widest">INC. MANAGER</p>
                        </div>
                    </div>
                </div>

                <nav className="flex-1 p-4 space-y-2 mt-16 md:mt-0 overflow-y-auto">
                    {navItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = location.pathname === item.path;
                        return (
                            <Link
                                key={item.path}
                                to={item.path}
                                onClick={() => setIsMobileMenuOpen(false)}
                                className={`flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 group ${isActive
                                    ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                    }`}
                            >
                                <Icon className={`w-5 h-5 ${isActive ? 'text-cyan-400' : 'text-slate-500 group-hover:text-slate-300'}`} />
                                <span className="font-medium tracking-wide text-sm uppercase">{item.label}</span>
                            </Link>
                        );
                    })}
                </nav>

                <div className="p-4 border-t border-slate-800">
                    <div className="bg-slate-950 rounded-lg p-4 mb-4 border border-slate-800">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs text-slate-500 uppercase tracking-wider">System Status</span>
                             <Activity className={`w-4 h-4 ${serverStatus === 'ONLINE' ? 'text-green-500' : serverStatus === 'UNCONFIGURED' ? 'text-yellow-500' : 'text-slate-500'}`} />
                        </div>
                        <div className={`text-sm font-mono ${serverStatus === 'ONLINE' ? 'text-green-400' : serverStatus === 'UNCONFIGURED' ? 'text-yellow-400' : 'text-slate-400'}`}>
                            {serverStatus}
                        </div>
                    </div>
                    <button
                        onClick={logout}
                        className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400 transition-colors"
                    >
                        <LogOut className="w-5 h-5" />
                        <span className="font-medium tracking-wide text-sm uppercase">Logout</span>
                    </button>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col overflow-hidden bg-slate-950 relative w-full">
                {/* Top Bar (Desktop) */}
                <header className="hidden md:flex h-16 bg-slate-900/50 border-b border-slate-800 items-center justify-between px-8 backdrop-blur-sm">
                    <h2 className="text-lg font-medium text-white tracking-wide uppercase">
                        {navItems.find(i => i.path === location.pathname)?.label || 'Dashboard'}
                    </h2>
                    <div className="flex items-center gap-4">
                         <div className={`h-2 w-2 rounded-full ${serverStatus === 'ONLINE' ? 'bg-green-500 animate-pulse' : serverStatus === 'UNCONFIGURED' ? 'bg-yellow-500' : 'bg-slate-500'}`}></div>
                         <span className="text-xs text-slate-500 font-mono">{connected ? 'MANAGER CONNECTION ESTABLISHED' : 'RECONNECTING TO MANAGER...'}</span>
                    </div>
                </header>

                {/* Content Area */}
                <main className="flex-1 overflow-auto p-4 md:p-6 relative mt-16 md:mt-0">
                    <Outlet />
                </main>
            </div>
            {/* Error Toast */}
            {errorMsg && (
                <div className="fixed bottom-4 right-4 z-50 bg-red-500/90 text-white px-6 py-4 rounded-lg shadow-2xl border border-red-400 backdrop-blur-sm animate-bounce">
                    <div className="flex items-center gap-3">
                        <Activity className="w-6 h-6" />
                        <div>
                            <h4 className="font-bold uppercase tracking-wider text-sm">System Error</h4>
                            <p className="font-mono text-sm">{errorMsg}</p>
                        </div>
                        <button onClick={clearStartError} className="ml-4 hover:text-red-200"><X className="w-5 h-5" /></button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Dashboard;

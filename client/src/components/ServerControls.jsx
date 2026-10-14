import React, { useEffect, useState } from 'react';
import { Power, RotateCw, Square } from 'lucide-react';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';

const STARTUP_ESTIMATE_SECONDS = 60;

const statusMessage = (status, isAdmin) => {
    switch (status) {
        case 'ONLINE': return 'Server is ONLINE! You can join now.';
        case 'OFFLINE': return 'Server is OFFLINE.';
        case 'STARTING': return 'Server is starting...';
        case 'STOPPING': return 'Server is stopping...';
        case 'UNCONFIGURED': return isAdmin
            ? 'Minecraft is not installed yet. Install it from the Server page.'
            : 'Minecraft is not installed yet. Ask an admin to install the server.';
        default: return '';
    }
};

const ServerControls = () => {
    const { status, statusSince, operation, emit } = useSocket();
    const { user } = useAuth();
    const [now, setNow] = useState(() => Date.now());

    // Tick only while starting, to drive the countdown.
    useEffect(() => {
        if (status !== 'STARTING') return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [status]);

    const elapsed = Math.max(0, Math.floor((now - statusSince) / 1000));
    const countdown = status === 'STARTING' ? STARTUP_ESTIMATE_SECONDS - elapsed : null;
    const busy = Boolean(operation);
    const message = status === 'STARTING' && countdown <= 0
        ? 'Server should be ready soon...'
        : statusMessage(status, user?.role === 'admin');

    const canStart = status === 'OFFLINE' && !busy;
    const canStop = (status === 'ONLINE' || status === 'STARTING') && !busy;

    return (
        <div className="p-6 max-w-4xl mx-auto">
            <h1 className="text-2xl font-bold text-white mb-6">Server Controls</h1>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <button
                    onClick={() => emit('start')}
                    disabled={!canStart}
                    className={`flex flex-col items-center justify-center p-8 rounded-xl transition-all group ${!canStart
                        ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                        : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
                        }`}
                >
                    <div className={`p-4 rounded-full mb-4 transition-transform ${canStart ? 'bg-green-500/20 group-hover:scale-110' : 'bg-slate-700'}`}>
                        <Power className={`w-8 h-8 ${canStart ? 'text-green-400' : 'text-slate-500'}`} />
                    </div>
                    <span className={`text-lg font-bold uppercase tracking-wider ${canStart ? 'text-green-400' : 'text-slate-500'}`}>Start Server</span>
                </button>

                <button
                    onClick={() => emit('restart')}
                    disabled={!canStop}
                    className={`flex flex-col items-center justify-center p-8 rounded-xl transition-all group ${!canStop
                        ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                        : 'bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20'
                        }`}
                >
                    <div className={`p-4 rounded-full mb-4 transition-transform ${canStop ? 'bg-yellow-500/20 group-hover:scale-110' : 'bg-slate-700'}`}>
                        <RotateCw className={`w-8 h-8 ${canStop ? 'text-yellow-400' : 'text-slate-500'}`} />
                    </div>
                    <span className={`text-lg font-bold uppercase tracking-wider ${canStop ? 'text-yellow-400' : 'text-slate-500'}`}>Restart Server</span>
                </button>

                <button
                    onClick={() => emit('stop')}
                    disabled={!canStop}
                    className={`flex flex-col items-center justify-center p-8 rounded-xl transition-all group ${!canStop
                        ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                        : 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
                        }`}
                >
                    <div className={`p-4 rounded-full mb-4 transition-transform ${canStop ? 'bg-red-500/20 group-hover:scale-110' : 'bg-slate-700'}`}>
                        <Square className={`w-8 h-8 ${canStop ? 'text-red-400' : 'text-slate-500'}`} />
                    </div>
                    <span className={`text-lg font-bold uppercase tracking-wider ${canStop ? 'text-red-400' : 'text-slate-500'}`}>Stop Server</span>
                </button>
            </div>

            <div className="mt-8 p-6 bg-slate-900 rounded-lg border border-slate-800 text-center">
                <div className="text-xl font-mono font-bold text-white mb-2">
                    STATUS: <span className={
                        status === 'ONLINE' ? 'text-green-400' :
                            status === 'STARTING' || status === 'STOPPING' ? 'text-yellow-400' :
                                status === 'UNCONFIGURED' ? 'text-yellow-400' : 'text-red-400'
                    }>{status}</span>
                </div>
                {message && (
                    <p className="text-slate-400 text-lg animate-pulse">
                        {message}
                    </p>
                )}
                {busy && (
                    <p className="text-cyan-400 text-sm font-mono mt-2">
                        Operation in progress: {operation.kind}
                    </p>
                )}
                {countdown !== null && countdown > 0 && (
                    <p className="text-cyan-400 text-2xl font-bold mt-2">
                        Estimated time: {countdown}s
                    </p>
                )}
            </div>
        </div>
    );
};

export default ServerControls;

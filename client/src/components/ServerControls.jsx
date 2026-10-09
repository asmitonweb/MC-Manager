import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { Power, RotateCw, Square } from 'lucide-react';

const ServerControls = () => {
    const [socket, setSocket] = useState(null);
    const [status, setStatus] = useState('UNCONFIGURED');
    const [message, setMessage] = useState('');
    const [countdown, setCountdown] = useState(null);

    const updateStatusState = (newStatus) => {
        setStatus(newStatus);
        if (newStatus === 'ONLINE') {
            setMessage('Server is ONLINE! You can join now.');
            setCountdown(null);
        } else if (newStatus === 'OFFLINE') {
            setMessage('Server is OFFLINE.');
            setCountdown(null);
        } else if (newStatus === 'STARTING') {
            setMessage('Server is starting...');
            setCountdown(60);
        } else if (newStatus === 'STOPPING') {
            setMessage('Server is stopping...');
            setCountdown(null);
        } else if (newStatus === 'UNCONFIGURED') {
            setMessage('Minecraft is not configured yet. Add the server core before starting it.');
            setCountdown(null);
        }
    };

    useEffect(() => {
        // Fetch initial status via API to ensure sync
        fetch('/api/status')
            .then(res => res.json())
            .then(data => {
                if (data.status) {
                    updateStatusState(data.status);
                }
            })
            .catch(err => console.error('Failed to fetch status:', err));

        const newSocket = io('/', { withCredentials: true });
        setSocket(newSocket);

        newSocket.on('status', (newStatus) => {
            updateStatusState(newStatus);
        });

        return () => newSocket.disconnect();
    }, []);

    useEffect(() => {
        if (countdown === null) return;
        if (countdown <= 0) {
            setMessage('Server should be ready soon...');
            return;
        }

        const timer = setInterval(() => {
            setCountdown(prev => prev - 1);
        }, 1000);

        return () => clearInterval(timer);
    }, [countdown]);

    const handleAction = (action) => {
        if (socket) {
            socket.emit(action);
        }
    };

    return (
        <div className="p-6 max-w-4xl mx-auto">
            <h1 className="text-2xl font-bold text-white mb-6">Server Controls</h1>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <button
                    onClick={() => handleAction('start')}
                    disabled={status !== 'OFFLINE'}
                    className={`flex flex-col items-center justify-center p-8 rounded-xl transition-all group ${status !== 'OFFLINE'
                        ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                        : 'bg-green-500/10 border border-green-500/20 hover:bg-green-500/20'
                        }`}
                >
                    <div className={`p-4 rounded-full mb-4 transition-transform ${status === 'OFFLINE' ? 'bg-green-500/20 group-hover:scale-110' : 'bg-slate-700'}`}>
                        <Power className={`w-8 h-8 ${status === 'OFFLINE' ? 'text-green-400' : 'text-slate-500'}`} />
                    </div>
                    <span className={`text-lg font-bold uppercase tracking-wider ${status === 'OFFLINE' ? 'text-green-400' : 'text-slate-500'}`}>Start Server</span>
                </button>

                <button
                    onClick={() => handleAction('restart')}
                    disabled={status === 'OFFLINE' || status === 'UNCONFIGURED'}
                    className={`flex flex-col items-center justify-center p-8 rounded-xl transition-all group ${status === 'OFFLINE' || status === 'UNCONFIGURED'
                        ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                        : 'bg-yellow-500/10 border border-yellow-500/20 hover:bg-yellow-500/20'
                        }`}
                >
                    <div className={`p-4 rounded-full mb-4 transition-transform ${status !== 'OFFLINE' ? 'bg-yellow-500/20 group-hover:scale-110' : 'bg-slate-700'}`}>
                        <RotateCw className={`w-8 h-8 ${status !== 'OFFLINE' ? 'text-yellow-400' : 'text-slate-500'}`} />
                    </div>
                    <span className={`text-lg font-bold uppercase tracking-wider ${status !== 'OFFLINE' ? 'text-yellow-400' : 'text-slate-500'}`}>Restart Server</span>
                </button>

                <button
                    onClick={() => handleAction('stop')}
                    disabled={status === 'OFFLINE' || status === 'UNCONFIGURED'}
                    className={`flex flex-col items-center justify-center p-8 rounded-xl transition-all group ${status === 'OFFLINE' || status === 'UNCONFIGURED'
                        ? 'bg-slate-800 border border-slate-700 opacity-50 cursor-not-allowed'
                        : 'bg-red-500/10 border border-red-500/20 hover:bg-red-500/20'
                        }`}
                >
                    <div className={`p-4 rounded-full mb-4 transition-transform ${status !== 'OFFLINE' ? 'bg-red-500/20 group-hover:scale-110' : 'bg-slate-700'}`}>
                        <Square className={`w-8 h-8 ${status !== 'OFFLINE' ? 'text-red-400' : 'text-slate-500'}`} />
                    </div>
                    <span className={`text-lg font-bold uppercase tracking-wider ${status !== 'OFFLINE' ? 'text-red-400' : 'text-slate-500'}`}>Stop Server</span>
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

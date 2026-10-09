import React, { useEffect, useState, useRef } from 'react';
import { Terminal as TerminalIcon, Send } from 'lucide-react';
import { useSocket } from '../context/SocketContext';

const Console = () => {
    const { logs, emit } = useSocket();
    const [command, setCommand] = useState('');
    const bottomRef = useRef(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    const sendCommand = (e) => {
        e.preventDefault();
        if (!command.trim()) return;
        emit('command', command);
        setCommand('');
    };

    return (
        <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <TerminalIcon className="w-4 h-4 text-slate-500" />
                    <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">System Terminal</span>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => emit('start')}
                        className="px-3 py-1 bg-green-500/10 text-green-400 text-xs font-bold rounded hover:bg-green-500/20 border border-green-500/20 transition-colors uppercase tracking-wider"
                    >
                        Initialize
                    </button>
                    <button
                        onClick={() => emit('restart')}
                        className="px-3 py-1 bg-yellow-500/10 text-yellow-400 text-xs font-bold rounded hover:bg-yellow-500/20 border border-yellow-500/20 transition-colors uppercase tracking-wider"
                    >
                        Reboot
                    </button>
                    <button
                        onClick={() => emit('stop')}
                        className="px-3 py-1 bg-red-500/10 text-red-400 text-xs font-bold rounded hover:bg-red-500/20 border border-red-500/20 transition-colors uppercase tracking-wider"
                    >
                        Terminate
                    </button>
                </div>
            </div>

            <div className="flex-1 p-4 overflow-auto font-mono text-xs space-y-1 bg-slate-950/50">
                {logs.length === 0 && (
                    <div className="text-slate-600 italic">Waiting for server stream...</div>
                )}
                {logs.map((log, i) => (
                    <div key={i} className="whitespace-pre-wrap break-words text-slate-300 border-l-2 border-transparent hover:border-slate-700 pl-2">
                        {log}
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            <form onSubmit={sendCommand} className="p-2 bg-slate-950 border-t border-slate-800 flex gap-2">
                <div className="flex-1 relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cyan-500 font-mono">{'>'}</span>
                    <input
                        type="text"
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2 pl-8 pr-4 text-slate-200 font-mono text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                        placeholder="Execute command..."
                    />
                </div>
                <button
                    type="submit"
                    className="p-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors"
                >
                    <Send className="w-4 h-4" />
                </button>
            </form>
        </div>
    );
};

export default Console;

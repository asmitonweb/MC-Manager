import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Play, Square } from 'lucide-react';

const Ping = () => {
    const [output, setOutput] = useState([]);
    const [isRunning, setIsRunning] = useState(false);
    const bottomRef = useRef(null);

    useEffect(() => {
        if (bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [output]);

    const addLine = (text, color = 'text-slate-300') => {
        setOutput(prev => [...prev, { text, color, id: Date.now() + Math.random() }]);
    };

    const runPing = async () => {
        if (isRunning) return;
        setIsRunning(true);
        setOutput([]); // Clear previous output

        addLine(`> ping ${window.location.hostname}`, 'text-cyan-400 font-bold');
        addLine(`Pinging ${window.location.hostname} with 32 bytes of data:`);

        const maxPackets = 4;
        const results = [];

        const pingPacket = async (seq) => {
            if (seq > maxPackets) {
                // Summary
                const lost = maxPackets - results.length;
                const min = results.length > 0 ? Math.min(...results) : 0;
                const max = results.length > 0 ? Math.max(...results) : 0;
                const avg = results.length > 0 ? Math.round(results.reduce((a, b) => a + b, 0) / results.length) : 0;

                addLine(' ');
                addLine(`Ping statistics for ${window.location.hostname}:`, 'text-white font-bold');
                addLine(`    Packets: Sent = ${maxPackets}, Received = ${results.length}, Lost = ${lost} (${(lost / maxPackets) * 100}% loss),`);
                if (results.length > 0) {
                    addLine('Approximate round trip times in milli-seconds:');
                    addLine(`    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms`);
                }

                addLine(' ');
                addLine('> _', 'text-cyan-400 animate-pulse');
                setIsRunning(false);
                return;
            }

            const start = Date.now();

            try {
                // Use HTTP fetch instead of Socket.IO for simplicity and robustness through tunnels
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

                const res = await fetch('/api/ping', {
                    method: 'GET',
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (res.ok) {
                    const end = Date.now();
                    const rtt = end - start;
                    results.push(rtt);
                    addLine(`Reply from ${window.location.hostname}: bytes=32 time=${rtt}ms TTL=64`, 'text-green-400');
                } else {
                    throw new Error('Server error');
                }
            } catch (e) {
                addLine(`Request timed out.`, 'text-red-400');
            }

            // Delay before next packet
            setTimeout(() => pingPacket(seq + 1), 1000);
        };

        pingPacket(1);
    };

    return (
        <div className="h-full flex flex-col bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-2xl font-mono text-sm md:text-base">
            {/* Header */}
            <div className="bg-slate-900 p-4 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Terminal className="w-5 h-5 text-slate-400" />
                    <span className="text-slate-200 font-bold">Command Prompt - ping</span>
                </div>
                <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
                    <div className="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
                    <div className="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
                </div>
            </div>

            {/* Terminal Output */}
            <div className="flex-1 p-6 overflow-y-auto space-y-1 font-mono">
                {output.length === 0 && !isRunning && (
                    <div className="text-slate-500">
                        Ready to ping. Click the button below to start.
                    </div>
                )}

                {output.map((line) => (
                    <div key={line.id} className={`${line.color} break-all`}>
                        {line.text}
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            {/* Controls */}
            <div className="p-4 border-t border-slate-800 bg-slate-900/50">
                <button
                    onClick={runPing}
                    disabled={isRunning}
                    className={`
                        flex items-center gap-2 px-6 py-2 rounded-lg font-bold uppercase tracking-wider transition-all
                        ${isRunning
                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                            : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-500/20'}
                    `}
                >
                    {isRunning ? (
                        <>
                            <Square className="w-4 h-4 fill-current" />
                            Running...
                        </>
                    ) : (
                        <>
                            <Play className="w-4 h-4 fill-current" />
                            Start Ping
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default Ping;

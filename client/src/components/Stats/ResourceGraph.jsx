import React, { useState, useEffect } from 'react';
import { Cpu, HardDrive } from 'lucide-react';
import { useSocket } from '../../context/SocketContext';

// Simple SVG Line Graph
const Graph = ({ data, color }) => {
    if (data.length < 2) return null;
    const max = 100;
    const width = 100;
    const height = 40;
    const points = data.map((val, i) => {
        const x = (i / (data.length - 1)) * width;
        const y = height - (val / max) * height;
        return `${x},${y}`;
    }).join(' ');

    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
            <polyline
                fill="none"
                stroke={color}
                strokeWidth="2"
                points={points}
                vectorEffect="non-scaling-stroke"
            />
            <path
                d={`M 0,${height} L ${points} L ${width},${height}`}
                fill={color}
                fillOpacity="0.1"
            />
        </svg>
    );
};

const ResourceGraph = () => {
    const { socket } = useSocket();
    const [stats, setStats] = useState({ cpu: 0, ram: 0, ramUsed: 0, ramTotal: 0, mcRamUsed: null });
    const [history, setHistory] = useState({ cpu: [], ram: [] });

    // The server only samples host metrics while someone is subscribed.
    useEffect(() => {
        if (!socket) return;
        const subscribe = () => socket.emit('stats_subscribe');
        const onStats = (data) => {
            setStats(data);
            setHistory(prev => ({
                cpu: [...prev.cpu, data.cpu].slice(-30), // Keep last 30 points
                ram: [...prev.ram, data.ram].slice(-30),
            }));
        };

        socket.on('stats', onStats);
        socket.on('connect', subscribe);
        subscribe();
        return () => {
            socket.emit('stats_unsubscribe');
            socket.off('stats', onStats);
            socket.off('connect', subscribe);
        };
    }, [socket]);

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
            {/* CPU Card */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 flex flex-col shadow-xl">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <Cpu className="w-5 h-5 text-cyan-400" />
                        <span className="text-sm font-mono text-slate-400 uppercase tracking-widest">CPU Load</span>
                    </div>
                    <span className="text-2xl font-bold text-slate-200 font-mono">{stats.cpu}%</span>
                </div>
                <div className="flex-1 relative min-h-[100px] bg-slate-950/50 rounded-lg border border-slate-800/50 p-2">
                    <Graph data={history.cpu} color="#22d3ee" />
                </div>
            </div>

            {/* RAM Card */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 flex flex-col shadow-xl">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <HardDrive className="w-5 h-5 text-purple-400" />
                        <span className="text-sm font-mono text-slate-400 uppercase tracking-widest">Memory Usage</span>
                    </div>
                    <div className="text-right">
                        <span className="text-2xl font-bold text-slate-200 font-mono">{stats.ram}%</span>
                        <div className="text-xs text-slate-500 font-mono">{stats.ramUsed}GB / {stats.ramTotal}GB</div>
                        {stats.mcRamUsed !== null && (
                            <div className="text-xs text-slate-500 font-mono">Minecraft: {stats.mcRamUsed}GB</div>
                        )}
                    </div>
                </div>
                <div className="flex-1 relative min-h-[100px] bg-slate-950/50 rounded-lg border border-slate-800/50 p-2">
                    <Graph data={history.ram} color="#c084fc" />
                </div>
            </div>
        </div>
    );
};

export default ResourceGraph;

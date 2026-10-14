import React, { useCallback, useEffect, useState } from 'react';
import { Cpu, MemoryStick, Gauge, Timer, HardDrive, RefreshCw, Info } from 'lucide-react';
import { useRoom } from '../../context/SocketContext';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';

const POINTS = 60;

// Small SVG sparkline; `max` sets the top of the scale.
const Graph = ({ data, color, max = 100 }) => {
    if (data.length < 2) return <div className="h-full flex items-center justify-center text-[10px] text-slate-600 font-mono">collecting…</div>;
    const width = 100;
    const height = 40;
    const points = data.map((val, i) => `${(i / (POINTS - 1)) * width},${height - (Math.min(val, max) / max) * height}`).join(' ');
    return (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
            <polyline fill="none" stroke={color} strokeWidth="2" points={points} vectorEffect="non-scaling-stroke" />
            <path d={`M 0,${height} L ${points} L ${(data.length - 1) / (POINTS - 1) * width},${height}`} fill={color} fillOpacity="0.1" />
        </svg>
    );
};

const Card = ({ icon, color, label, value, sub, data, max }) => (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 flex flex-col shadow-xl min-h-[170px]">
        <div className="flex items-start justify-between mb-3 gap-2">
            <div className="flex items-center gap-2">
                {React.createElement(icon, { className: "w-4 h-4", style: { color } })}
                <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">{label}</span>
            </div>
            <div className="text-right">
                <div className="text-2xl font-bold text-slate-200 font-mono leading-none">{value}</div>
                {sub && <div className="text-[11px] text-slate-500 font-mono mt-1">{sub}</div>}
            </div>
        </div>
        <div className="flex-1 bg-slate-950/50 rounded-lg border border-slate-800/50 p-2 min-h-[70px]">
            <Graph data={data} color={color} max={max} />
        </div>
    </div>
);

const uptime = (ms) => {
    if (ms === null || ms === undefined) return '—';
    const m = Math.floor(ms / 60000);
    return m >= 1440 ? `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

const DISK_PARTS = [
    { key: 'worlds', label: 'Worlds', color: '#22d3ee' },
    { key: 'backups', label: 'Backups', color: '#c084fc' },
    { key: 'setups', label: 'Parked setups', color: '#f59e0b' },
    { key: 'serverOther', label: 'Server files', color: '#64748b' },
];

const ResourceGraph = () => {
    const [stats, setStats] = useState(null);
    const [history, setHistory] = useState({ cpu: [], ram: [], mc: [], mspt: [] });
    const [info, setInfo] = useState(null);
    const [refreshing, setRefreshing] = useState(false);

    // The server samples only while this page is open.
    useRoom('stats', {
        stats: (data) => {
            setStats((prev) => ({ ...data, tick: data.tick === undefined ? prev?.tick : data.tick }));
            setHistory((prev) => ({
                cpu: [...prev.cpu, data.cpu].slice(-POINTS),
                ram: [...prev.ram, data.ram].slice(-POINTS),
                mc: data.mcRamUsed === null ? prev.mc : [...prev.mc, Number(data.mcRamUsed)].slice(-POINTS),
                mspt: data.tick ? [...prev.mspt, data.tick.mspt].slice(-POINTS) : prev.mspt,
            }));
        },
    });

    const loadInfo = useCallback(() => api.get('/api/system').then(setInfo).catch(() => {}), []);
    useEffect(() => { loadInfo(); }, [loadInfo]);

    const refreshDisk = async () => {
        setRefreshing(true);
        try {
            const disk = await api.post('/api/system/disk');
            setInfo((prev) => ({ ...prev, disk }));
        } finally {
            setRefreshing(false);
        }
    };

    const tick = stats?.tick;
    const diskTotal = info?.disk ? DISK_PARTS.reduce((sum, part) => sum + (info.disk[part.key] || 0), 0) : 0;
    const maxMem = Number.parseFloat(info?.setup?.memory?.max) || null;

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
                <Card icon={Cpu} color="#22d3ee" label="Host CPU" value={stats ? `${stats.cpu}%` : '—'} data={history.cpu} />
                <Card icon={MemoryStick} color="#c084fc" label="Host memory" value={stats ? `${stats.ram}%` : '—'} sub={stats && `${stats.ramUsed} / ${stats.ramTotal} GB`} data={history.ram} />
                <Card icon={MemoryStick} color="#4ade80" label="Minecraft memory" value={stats?.mcRamUsed ? `${stats.mcRamUsed} GB` : '—'}
                    sub={maxMem ? `heap limit ${info.setup.memory.max}` : 'not running'} data={history.mc} max={maxMem ? maxMem * 1.3 : 8} />
                <Card icon={Gauge} color={tick && tick.mspt > 50 ? '#f87171' : '#facc15'} label="Tick time" value={tick ? `${tick.mspt} ms` : '—'}
                    sub={tick ? `${tick.tps} TPS${tick.frozen ? ' · paused' : ''}` : 'needs the server online (1.20.3+)'} data={history.mspt} max={60} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 shadow-xl">
                    <div className="flex items-center gap-2 mb-3">
                        <Info className="w-4 h-4 text-slate-500" />
                        <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">Server</span>
                    </div>
                    <dl className="grid grid-cols-2 gap-y-2 text-sm">
                        <dt className="text-slate-500">World</dt><dd className="text-slate-200">{info?.world?.name || '—'}</dd>
                        <dt className="text-slate-500">Version</dt><dd className="text-slate-200 font-mono">{info?.setup ? `${info.setup.loader} ${info.setup.minecraftVersion}` : '—'}</dd>
                        <dt className="text-slate-500">Loader</dt><dd className="text-slate-200 font-mono">{info?.setup?.loaderVersion || '—'}</dd>
                        <dt className="text-slate-500">Java</dt><dd className="text-slate-200 font-mono">{info?.setup?.javaMajor || '—'}</dd>
                        <dt className="text-slate-500">Memory</dt><dd className="text-slate-200 font-mono">{info?.setup?.memory ? `${info.setup.memory.min} – ${info.setup.memory.max}` : '—'}</dd>
                        <dt className="text-slate-500 flex items-center gap-1"><Timer className="w-3 h-3" /> Minecraft up</dt><dd className="text-slate-200 font-mono">{uptime(info?.minecraftUptimeMs)}</dd>
                        <dt className="text-slate-500 flex items-center gap-1"><Timer className="w-3 h-3" /> Manager up</dt><dd className="text-slate-200 font-mono">{uptime(info?.managerUptimeMs)}</dd>
                    </dl>
                </div>

                <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 shadow-xl">
                    <div className="flex items-center gap-2 mb-3">
                        <HardDrive className="w-4 h-4 text-slate-500" />
                        <span className="text-xs font-mono text-slate-400 uppercase tracking-widest mr-auto">Disk</span>
                        <button type="button" onClick={refreshDisk} disabled={refreshing} title="Recount" className="p-1 text-slate-500 hover:text-white disabled:animate-spin">
                            <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    {info?.disk ? (
                        <div className="space-y-3">
                            <div className="h-3 rounded-full overflow-hidden flex bg-slate-800">
                                {DISK_PARTS.map((part) => (
                                    <div key={part.key} title={part.label} style={{ width: `${diskTotal ? (100 * info.disk[part.key]) / (diskTotal + (info.disk.free || 0)) : 0}%`, background: part.color }} />
                                ))}
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                                {DISK_PARTS.map((part) => (
                                    <div key={part.key} className="flex items-center gap-2">
                                        <span className="w-2.5 h-2.5 rounded-sm" style={{ background: part.color }} />
                                        <span className="text-slate-400">{part.label}</span>
                                        <span className="ml-auto text-slate-200 font-mono">{formatBytes(info.disk[part.key])}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="text-xs text-slate-500 font-mono">Free on the drive: {formatBytes(info.disk.free)} · counted {new Date(info.disk.at).toLocaleTimeString()}</div>
                        </div>
                    ) : <div className="text-sm text-slate-500">Counting…</div>}
                </div>
            </div>
        </div>
    );
};

export default ResourceGraph;

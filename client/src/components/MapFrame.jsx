import React, { useEffect, useState } from 'react';
import { Map as MapIcon, Loader2, Pause, RefreshCw, Power } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRoom, useSocket } from '../context/SocketContext';
import { api } from '../lib/api';
import { Button, Notice } from './ui';
import JobProgress from './JobProgress';

// BlueMap renders only while this page is open (the server pauses it a minute after the last viewer leaves).
const MapFrame = () => {
    const { user } = useAuth();
    const { status, jobs } = useSocket();
    const [map, setMap] = useState(null);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState(null);
    const [jobId, setJobId] = useState(null);
    const isAdmin = user?.role === 'admin';

    useRoom('map', { map_status: setMap });
    const jobDone = jobId && jobs[jobId] && jobs[jobId].status !== 'running';
    useEffect(() => {
        api.get('/api/map').then(setMap).catch((err) => setError(err.message));
    }, [jobDone, status]);

    const run = async (request) => {
        setError(null);
        setMessage(null);
        try {
            const result = await request();
            if (result?.kind) setJobId(result.id);
            if (result?.message) setMessage(result.message);
        } catch (err) {
            setError(err.message);
        }
    };

    if (!map) return <div className="text-slate-500 font-mono text-sm">{error || 'Loading…'}</div>;

    if (!map.installed) {
        return (
            <div className="max-w-2xl space-y-4">
                {error && <Notice tone="error">{error}</Notice>}
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
                    <div className="flex items-center gap-3">
                        <MapIcon className="w-6 h-6 text-cyan-400" />
                        <h3 className="text-white font-bold">Live map (BlueMap)</h3>
                    </div>
                    <p className="text-sm text-slate-400">
                        A 3D map of the active world in the browser, with live player positions. It only renders while someone has this page open
                        and pauses a minute after the last viewer leaves, so an unwatched server pays nothing for it.
                    </p>
                    <p className="text-xs text-slate-500">Installed per setup (server-side only; players don&apos;t need it). The first render of a big world takes a while and happens while you watch.</p>
                    {isAdmin ? (
                        <>
                            {status !== 'OFFLINE' && <Notice tone="warn">Stop the server to install BlueMap.</Notice>}
                            <Button icon={Power} disabled={status !== 'OFFLINE'} onClick={() => run(() => api.post('/api/map/enable'))}>Enable BlueMap</Button>
                        </>
                    ) : <p className="text-sm text-slate-500">Ask an admin to enable the map.</p>}
                    {jobId && <JobProgress jobId={jobId} showLog={false} />}
                </div>
            </div>
        );
    }

    return (
        <div className="w-full h-full flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
                {map.rendering
                    ? <span className="flex items-center gap-1.5 text-cyan-300"><Loader2 className="w-3.5 h-3.5 animate-spin" /> rendering while you watch</span>
                    : <span className="flex items-center gap-1.5 text-slate-500"><Pause className="w-3.5 h-3.5" /> {map.running ? 'paused' : 'server offline'}</span>}
                {map.status && <span className="text-slate-500 truncate max-w-xl" title={map.status}>{map.status.split('\n').find((l) => /%|render|update/i.test(l)) || ''}</span>}
                {isAdmin && (
                    <div className="ml-auto flex gap-2">
                        <Button variant="secondary" icon={RefreshCw} disabled={!map.running} onClick={() => run(() => api.post('/api/map/render'))}>Render changes</Button>
                        <Button variant="ghost" disabled={status !== 'OFFLINE'} title="Stop the server to remove" onClick={() => run(() => api.post('/api/map/disable'))}>Remove</Button>
                    </div>
                )}
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            {message && <Notice tone="info">{message}</Notice>}
            {jobId && <JobProgress jobId={jobId} showLog={false} />}
            <div className="flex-1 min-h-[400px] bg-slate-950 relative rounded-xl overflow-hidden border border-slate-800 shadow-xl">
                {map.ready ? (
                    <iframe src="/map/" className="w-full h-full border-0" title="BlueMap" allowFullScreen />
                ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-center p-6">
                        <p className="text-sm text-slate-500 max-w-md">
                            {map.running
                                ? 'BlueMap is preparing the map for this world. Keep this page open; it appears after the first tiles render.'
                                : 'Start the server. The map is prepared on its first run with BlueMap.'}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default MapFrame;

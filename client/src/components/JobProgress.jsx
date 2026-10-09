import React from 'react';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useSocket } from '../context/SocketContext';

// Live progress for a background job, fed by `job_update` socket events.
const JobProgress = ({ jobId, initialJob, showLog = true }) => {
    const { jobs } = useSocket();
    const job = jobs[jobId] || initialJob;
    if (!job) return null;

    const failed = job.status === 'failed';
    const done = job.status === 'succeeded';
    const Icon = failed ? XCircle : done ? CheckCircle2 : Loader2;

    return (
        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
                <Icon className={`w-5 h-5 ${failed ? 'text-red-400' : done ? 'text-green-400' : 'text-cyan-400 animate-spin'}`} />
                <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-200 truncate">{failed ? job.error?.message : job.step}</div>
                    <div className="text-xs text-slate-500 font-mono uppercase">{job.kind} · {job.status}</div>
                </div>
                <span className="text-sm font-mono text-slate-400">{job.progress}%</span>
            </div>
            <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                <div
                    className={`h-full transition-all duration-300 ${failed ? 'bg-red-500' : done ? 'bg-green-500' : 'bg-cyan-500'}`}
                    style={{ width: `${job.progress}%` }}
                />
            </div>
            {showLog && job.log?.length > 0 && (
                <pre className="max-h-48 overflow-auto text-xs text-slate-400 font-mono whitespace-pre-wrap bg-slate-900/60 rounded p-2">
                    {job.log.slice(-40).join('\n')}
                </pre>
            )}
        </div>
    );
};

export default JobProgress;

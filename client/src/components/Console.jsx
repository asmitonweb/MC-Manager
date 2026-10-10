import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal as TerminalIcon, Send, Play, RotateCw, Square, ArrowDownToLine, Copy, Search } from 'lucide-react';
import { useRoom, useSocket } from '../context/SocketContext';
import { inputClass } from '../lib/format';

const MAX_LINES = 1000;
const ROW = 18;
const OVERSCAN = 20;
const HISTORY_KEY = 'mcm.consoleHistory';
const LINE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]+?)\/(INFO|WARN|ERROR|DEBUG|FATAL)\](?: \[[^\]]+\])?:? ?(.*)$/;
const CHIPS = [
    { label: 'list', command: 'list' },
    { label: 'say', command: 'say ' },
    { label: 'day', command: 'time set day' },
    { label: 'clear weather', command: 'weather clear' },
    { label: 'tp', command: 'tp ' },
    { label: 'gamerule', command: 'gamerule ' },
    { label: 'save', command: 'save-all' },
];
const LEVEL_STYLE = {
    WARN: 'text-yellow-300',
    ERROR: 'text-red-400',
    FATAL: 'text-red-400',
    CMD: 'text-cyan-300',
    SYS: 'text-purple-300',
    INFO: 'text-slate-300',
};

let lineId = 0;
// Splits pushed chunks into lines; continuation lines (stack traces) keep the previous level.
const toLines = (chunks, previousLevel = 'INFO') => {
    const out = [];
    let level = previousLevel;
    for (const chunk of chunks) {
        for (const raw of String(chunk).split(/\r?\n/)) {
            if (!raw) continue;
            const m = LINE.exec(raw);
            if (m) {
                level = m[3];
                out.push({ id: lineId += 1, time: m[1], thread: m[2], level, text: m[4] });
            } else {
                const own = raw.startsWith('> ') ? 'CMD' : /^\s|^\w+(\.\w+)+(Exception|Error)|^Caused by/.test(raw) ? level : 'SYS';
                out.push({ id: lineId += 1, time: null, thread: null, level: own, text: raw });
            }
        }
    }
    return out;
};

const readHistory = () => {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch {
        return [];
    }
};

const Console = () => {
    const { emit, status, operation } = useSocket();
    const [lines, setLines] = useState([]);
    const [filter, setFilter] = useState('');
    const [level, setLevel] = useState('all');
    const [follow, setFollow] = useState(true);
    const [command, setCommand] = useState('');
    const [history, setHistory] = useState(readHistory);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [view, setView] = useState({ top: 0, height: 600 });
    const scrollRef = useRef(null);
    const inputRef = useRef(null);

    useRoom('console', {
        log_history: (chunks) => setLines(toLines(chunks || []).slice(-MAX_LINES)),
        log: (chunk) => setLines((prev) => {
            const next = prev.concat(toLines([chunk], prev[prev.length - 1]?.level));
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
        }),
    });

    const visible = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        return lines.filter((line) => {
            if (level === 'warn' && !['WARN', 'ERROR', 'FATAL'].includes(line.level)) return false;
            if (level === 'error' && !['ERROR', 'FATAL'].includes(line.level)) return false;
            return !needle || line.text.toLowerCase().includes(needle) || line.thread?.toLowerCase().includes(needle);
        });
    }, [lines, filter, level]);

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (follow && el) el.scrollTop = el.scrollHeight;
    }, [visible.length, follow]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return undefined;
        const observer = new ResizeObserver(() => setView((prev) => ({ ...prev, height: el.clientHeight })));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const onScroll = useCallback(() => {
        const el = scrollRef.current;
        setView({ top: el.scrollTop, height: el.clientHeight });
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2);
    }, []);

    const start = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
    const end = Math.min(visible.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);

    const send = (event) => {
        event.preventDefault();
        const text = command.trim();
        if (!text) return;
        emit('command', text);
        const next = [text, ...history.filter((entry) => entry !== text)].slice(0, 50);
        setHistory(next);
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        } catch {
            // History is a convenience only.
        }
        setHistoryIndex(-1);
        setCommand('');
        setFollow(true);
    };

    const onKeyDown = (event) => {
        if (event.key === 'ArrowUp' && history.length) {
            event.preventDefault();
            const index = Math.min(history.length - 1, historyIndex + 1);
            setHistoryIndex(index);
            setCommand(history[index]);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            const index = historyIndex - 1;
            setHistoryIndex(Math.max(-1, index));
            setCommand(index < 0 ? '' : history[index]);
        }
    };

    const copyVisible = () => {
        navigator.clipboard?.writeText(visible.map((line) => (line.time ? `[${line.time}] [${line.thread}/${line.level}] ${line.text}` : line.text)).join('\n')).catch(() => {});
    };

    const busy = Boolean(operation);
    const running = ['ONLINE', 'STARTING'].includes(status);
    const online = status === 'ONLINE';

    return (
        <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
            <div className="bg-slate-950 p-2 md:p-3 border-b border-slate-800 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2 mr-auto">
                    <TerminalIcon className="w-4 h-4 text-slate-500" />
                    <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">Console</span>
                    <span className="text-[10px] font-mono text-slate-600">{visible.length}/{lines.length}</span>
                </div>
                <div className="relative">
                    <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className={`${inputClass} !py-1 !pl-7 !w-36 text-xs`} />
                </div>
                <select value={level} onChange={(e) => setLevel(e.target.value)} className={`${inputClass} !py-1 !w-auto text-xs`}>
                    <option value="all">All</option>
                    <option value="warn">Warnings</option>
                    <option value="error">Errors</option>
                </select>
                <button type="button" onClick={copyVisible} title="Copy visible lines" className="p-1.5 text-slate-400 hover:text-white rounded hover:bg-slate-800"><Copy className="w-4 h-4" /></button>
                <div className="flex gap-1">
                    <button type="button" disabled={running || busy} onClick={() => emit('start')} title="Start" className="p-1.5 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-30"><Play className="w-4 h-4" /></button>
                    <button type="button" disabled={!online || busy} onClick={() => emit('restart')} title="Restart" className="p-1.5 rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20 disabled:opacity-30"><RotateCw className="w-4 h-4" /></button>
                    <button type="button" disabled={!running || busy} onClick={() => emit('stop')} title="Stop" className="p-1.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-30"><Square className="w-4 h-4" /></button>
                </div>
            </div>

            <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto font-mono text-xs bg-slate-950/50 relative">
                {lines.length === 0 && <div className="p-4 text-slate-600 italic">Waiting for server output…</div>}
                <div style={{ height: visible.length * ROW, position: 'relative', minWidth: '100%' }}>
                    <div style={{ transform: `translateY(${start * ROW}px)` }} className="px-3">
                        {visible.slice(start, end).map((line) => (
                            <div key={line.id} style={{ height: ROW, lineHeight: `${ROW}px` }} className={`whitespace-pre ${LEVEL_STYLE[line.level] || LEVEL_STYLE.INFO}`}>
                                {line.time && <span className="text-slate-600">{line.time} </span>}
                                {line.thread && <span className="text-slate-600">[{line.thread}] </span>}
                                {line.text}
                            </div>
                        ))}
                    </div>
                </div>
                {!follow && (
                    <button type="button" onClick={() => setFollow(true)} className="sticky bottom-3 left-full mr-3 flex items-center gap-1 px-3 py-1.5 rounded-full bg-cyan-600 text-white text-xs shadow-lg">
                        <ArrowDownToLine className="w-3 h-3" /> Latest
                    </button>
                )}
            </div>

            <div className="p-2 bg-slate-950 border-t border-slate-800 space-y-2">
                <div className="flex gap-1 overflow-x-auto">
                    {CHIPS.map((chip) => (
                        <button key={chip.label} type="button" disabled={!online}
                            onClick={() => { setCommand(chip.command); inputRef.current?.focus(); }}
                            className="shrink-0 px-2 py-0.5 rounded-full border border-slate-700 text-[11px] text-slate-400 hover:text-cyan-300 hover:border-cyan-500/50 disabled:opacity-30">
                            {chip.label}
                        </button>
                    ))}
                </div>
                <form onSubmit={send} className="flex gap-2">
                    <div className="flex-1 relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-cyan-500 font-mono">{'>'}</span>
                        <input
                            ref={inputRef}
                            value={command}
                            onChange={(e) => { setCommand(e.target.value); setHistoryIndex(-1); }}
                            onKeyDown={onKeyDown}
                            disabled={!online}
                            className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2 pl-8 pr-4 text-slate-200 font-mono text-sm focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 disabled:opacity-50"
                            placeholder={online ? 'Command (↑/↓ for history)' : 'Commands work while the server is online'}
                        />
                    </div>
                    <button type="submit" disabled={!online} className="p-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-40">
                        <Send className="w-4 h-4" />
                    </button>
                </form>
            </div>
        </div>
    );
};

export default Console;

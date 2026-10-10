import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Send, LogIn, LogOut, Skull, Trophy, ShieldAlert } from 'lucide-react';
import { useRoom, useSocket } from '../context/SocketContext';

const MAX_EVENTS = 300;
const FILTERS = [
    { id: 'all', label: 'Everything' },
    { id: 'chat', label: 'Chat' },
    { id: 'activity', label: 'Activity' },
];
const ACTIVITY = {
    join: { icon: LogIn, tone: 'text-green-400', text: 'joined the game' },
    leave: { icon: LogOut, tone: 'text-slate-500', text: 'left the game' },
    death: { icon: Skull, tone: 'text-red-400' },
    advancement: { icon: Trophy, tone: 'text-yellow-300' },
    refused: { icon: ShieldAlert, tone: 'text-orange-400', text: 'was refused (not whitelisted)' },
};

// Offline-mode skins are unknown, so players get a coloured initial instead of a head.
const hue = (name) => [...name].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 360, 7);
const Avatar = ({ name, system }) => (
    <div className="w-8 h-8 rounded-md flex items-center justify-center text-sm font-bold shrink-0"
        style={system ? { background: '#0e7490', color: '#ecfeff' } : { background: `hsl(${hue(name)} 45% 25%)`, color: `hsl(${hue(name)} 80% 80%)` }}>
        {name[0]?.toUpperCase()}
    </div>
);
const clock = (event) => event.time || new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const Chat = () => {
    const { emit, status } = useSocket();
    const [events, setEvents] = useState([]);
    const [filter, setFilter] = useState('all');
    const [input, setInput] = useState('');
    const bottomRef = useRef(null);

    useRoom('comms', {
        comms_history: (list) => setEvents((list || []).slice(-MAX_EVENTS)),
        comms_event: (event) => setEvents((prev) => [...prev, event].slice(-MAX_EVENTS)),
    });

    const shown = useMemo(() => events.filter((event) => filter === 'all' || (filter === 'chat' ? event.type === 'chat' : event.type !== 'chat')), [events, filter]);

    useLayoutEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [shown.length]);

    const send = (event) => {
        event.preventDefault();
        if (!input.trim()) return;
        emit('chat_send', input);
        setInput('');
    };
    const online = status === 'ONLINE';

    return (
        <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-mono text-slate-400 uppercase tracking-widest mr-auto">Comms</span>
                <div className="flex gap-1 bg-slate-900 p-1 rounded-lg">
                    {FILTERS.map((entry) => (
                        <button key={entry.id} type="button" onClick={() => setFilter(entry.id)}
                            className={`px-2.5 py-1 text-[11px] font-bold rounded uppercase ${filter === entry.id ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-500 hover:text-slate-300'}`}>
                            {entry.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 p-3 md:p-4 overflow-auto space-y-2 bg-slate-950/50">
                {shown.length === 0 && (
                    <div className="text-center text-slate-600 text-sm py-10">Nothing yet. In-game chat, joins, deaths and advancements appear here live.</div>
                )}
                {shown.map((event, index) => {
                    if (event.type === 'chat') {
                        return (
                            <div key={`${event.at}-${index}`} className="flex gap-3 items-start">
                                <Avatar name={event.name} system={event.system || event.dashboard} />
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2">
                                        <span className={`font-bold text-sm ${event.dashboard ? 'text-amber-300' : event.system ? 'text-cyan-300' : 'text-slate-200'}`}>{event.name}</span>
                                        <span className="text-[10px] text-slate-600 font-mono">{clock(event)}</span>
                                    </div>
                                    <div className="text-sm text-slate-300 break-words">{event.message}</div>
                                </div>
                            </div>
                        );
                    }
                    const style = ACTIVITY[event.type] || ACTIVITY.join;
                    const Icon = style.icon;
                    return (
                        <div key={`${event.at}-${index}`} className="flex items-center gap-2 pl-11 text-xs">
                            <Icon className={`w-3.5 h-3.5 ${style.tone}`} />
                            <span className="text-slate-300 font-medium">{event.name}</span>
                            <span className="text-slate-500">
                                {event.type === 'advancement' ? <>earned <span className="text-yellow-300">[{event.message}]</span></> : style.text || event.message}
                            </span>
                            <span className="text-[10px] text-slate-600 font-mono ml-auto">{clock(event)}</span>
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>

            <form onSubmit={send} className="p-3 bg-slate-950 border-t border-slate-800 flex gap-2">
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    maxLength={256}
                    disabled={!online}
                    className="flex-1 bg-slate-900 border border-slate-800 rounded-lg py-2 px-4 text-slate-200 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 disabled:opacity-50"
                    placeholder={online ? 'Message everyone in game as [Admin]' : 'Messages can be sent while the server is online'}
                />
                <button type="submit" disabled={!online} className="p-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-40">
                    <Send className="w-4 h-4" />
                </button>
            </form>
        </div>
    );
};

export default Chat;

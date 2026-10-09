import React, { useState } from 'react';
import { Users, Shield, UserX, Ban, ShieldOff, Clock } from 'lucide-react';
import { useSocket } from '../context/SocketContext';

const PlayerList = ({ players, isActive, onAction }) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {players.length === 0 && (
            <div className="col-span-full text-center text-slate-600 py-10">
                No {isActive ? 'active personnel' : 'records found'}.
            </div>
        )}
        {players.map((player) => (
            <div key={player.name} className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex items-center gap-4 group hover:border-cyan-500/50 transition-all">
                <img
                    src={`https://mc-heads.net/avatar/${player.name}/64`}
                    alt={player.name}
                    className={`w-12 h-12 rounded bg-slate-900 ${!isActive && 'grayscale opacity-50'}`}
                />
                <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-slate-200 truncate">{player.name}</h3>
                    {!isActive && player.lastSeen && (
                        <div className="flex items-center gap-1 text-xs text-slate-500">
                            <Clock className="w-3 h-3" />
                            <span>{new Date(player.lastSeen).toLocaleDateString()}</span>
                        </div>
                    )}

                    <div className="flex gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {isActive && (
                            <button
                                onClick={() => onAction('kick', player.name)}
                                className="p-1.5 rounded bg-orange-500/10 text-orange-400 hover:bg-orange-500/20"
                                title="Kick"
                            >
                                <UserX className="w-3 h-3" />
                            </button>
                        )}
                        <button
                            onClick={() => onAction('ban', player.name)}
                            className="p-1.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20"
                            title="Block (Ban)"
                        >
                            <Ban className="w-3 h-3" />
                        </button>
                        <button
                            onClick={() => onAction('op', player.name)}
                            className="p-1.5 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20"
                            title="Grant OP"
                        >
                            <Shield className="w-3 h-3" />
                        </button>
                        <button
                            onClick={() => onAction('deop', player.name)}
                            className="p-1.5 rounded bg-yellow-500/10 text-yellow-400 hover:bg-yellow-500/20"
                            title="Revoke OP"
                        >
                            <ShieldOff className="w-3 h-3" />
                        </button>
                    </div>
                </div>
            </div>
        ))}
    </div>
);

const Players = () => {
    const { players, emit } = useSocket();
    const activePlayers = players.active;
    const historyPlayers = players.history;
    const [tab, setTab] = useState('active'); // 'active' | 'history'

    const handleAction = (action, player) => {
        if (confirm(`Are you sure you want to ${action.toUpperCase()} ${player}?`)) {
            emit('player_action', { action, player });
        }
    };


    return (
        <div className="h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col">
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-slate-500" />
                    <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">Personnel Database</span>
                </div>
                <div className="flex gap-2 bg-slate-900 p-1 rounded-lg">
                    <button
                        onClick={() => setTab('active')}
                        className={`px-3 py-1 text-xs font-bold rounded transition-colors ${tab === 'active' ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        ACTIVE ({activePlayers.length})
                    </button>
                    <button
                        onClick={() => setTab('history')}
                        className={`px-3 py-1 text-xs font-bold rounded transition-colors ${tab === 'history' ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        HISTORY ({historyPlayers.length})
                    </button>
                </div>
            </div>

            <div className="p-6 overflow-auto">
                {tab === 'active' ? (
                    <PlayerList players={activePlayers} isActive={true} onAction={handleAction} />
                ) : (
                    <PlayerList players={historyPlayers} isActive={false} onAction={handleAction} />
                )}
            </div>
        </div>
    );
};

export default Players;

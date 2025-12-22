import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { MessageSquare, Send } from 'lucide-react';

const Chat = () => {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [socket, setSocket] = useState(null);
    const bottomRef = useRef(null);

    useEffect(() => {
        const newSocket = io('/', { withCredentials: true });
        setSocket(newSocket);

        newSocket.on('chat_message', (msg) => {
            setMessages(prev => [...prev, msg]);
        });

        return () => newSocket.disconnect();
    }, []);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const sendMessage = (e) => {
        e.preventDefault();
        if (!input.trim() || !socket) return;
        // Send to backend to broadcast via RCON/tellraw
        socket.emit('chat_send', input);
        setInput('');
    };

    return (
        <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-slate-500" />
                <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">Secure Comms Channel</span>
            </div>

            <div className="flex-1 p-4 overflow-auto space-y-3 bg-slate-950/50">
                {messages.length === 0 && (
                    <div className="text-center text-slate-600 text-sm py-10">No recent transmissions</div>
                )}
                {messages.map((msg, i) => (
                    <div key={i} className="flex gap-3 items-start group">
                        <div className="text-xs text-slate-500 font-mono mt-1 w-16">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        <div className="flex-1">
                            <span className="font-bold text-cyan-400 mr-2">{msg.sender}:</span>
                            <span className="text-slate-300">{msg.message}</span>
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            <form onSubmit={sendMessage} className="p-3 bg-slate-950 border-t border-slate-800 flex gap-2">
                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="flex-1 bg-slate-900 border border-slate-800 rounded-lg py-2 px-4 text-slate-200 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500"
                    placeholder="Broadcast message..."
                />
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

export default Chat;

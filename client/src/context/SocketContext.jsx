import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SocketContext = createContext(null);

const MAX_LOG_ENTRIES = 1000;
const MAX_CHAT_MESSAGES = 200;

// Owns the single Socket.IO connection for the dashboard and caches the state
// the server pushes, so pages that mount later still see history.
export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const [status, setStatus] = useState({ value: 'UNCONFIGURED', since: 0 });
    const [operation, setOperation] = useState(null);
    const [logs, setLogs] = useState([]);
    const [players, setPlayers] = useState({ active: [], history: [] });
    const [chat, setChat] = useState([]);
    const [jobs, setJobs] = useState({});
    const [startError, setStartError] = useState(null);

    useEffect(() => {
        const newSocket = io('/', { withCredentials: true });

        newSocket.on('connect', () => setConnected(true));
        newSocket.on('disconnect', () => setConnected(false));
        newSocket.on('status', (value) => setStatus((prev) => (
            prev.value === value ? prev : { value, since: Date.now() }
        )));
        newSocket.on('operation', setOperation);
        newSocket.on('log_history', (history) => setLogs(history || []));
        newSocket.on('log', (message) => setLogs((prev) => {
            const next = [...prev, message];
            return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
        }));
        newSocket.on('player_list', (data) => setPlayers({ active: data.active || [], history: data.history || [] }));
        newSocket.on('chat_message', (message) => setChat((prev) => [...prev, message].slice(-MAX_CHAT_MESSAGES)));
        newSocket.on('jobs', (list) => setJobs((prev) => ({
            ...prev,
            ...Object.fromEntries((list || []).map((job) => [job.id, job])),
        })));
        newSocket.on('job_update', (job) => setJobs((prev) => ({ ...prev, [job.id]: job })));
        newSocket.on('start_error', (message) => setStartError({ message, at: Date.now() }));

        // The connection is an external resource owned by this effect; exposing it
        // through state is the intended pattern here.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSocket(newSocket);
        return () => newSocket.disconnect();
    }, []);

    const emit = useCallback((event, ...args) => {
        socket?.emit(event, ...args);
    }, [socket]);

    const clearStartError = useCallback(() => setStartError(null), []);

    const value = {
        socket,
        connected,
        emit,
        status: status.value,
        statusSince: status.since,
        operation,
        logs,
        players,
        chat,
        jobs,
        startError,
        clearStartError,
    };

    return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useSocket = () => useContext(SocketContext);

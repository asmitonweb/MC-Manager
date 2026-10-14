import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SocketContext = createContext(null);

// Owns the single Socket.IO connection for the dashboard and caches the small
// state every page needs. Heavier streams (console, comms, stats) are joined by
// the page that shows them, via useRoom.
export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const [status, setStatus] = useState({ value: 'UNCONFIGURED', since: 0 });
    const [operation, setOperation] = useState(null);
    const [players, setPlayers] = useState({ active: [], history: [] });
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
        newSocket.on('player_list', (data) => setPlayers({ active: data.active || [], history: data.history || [] }));
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
        players,
        jobs,
        startError,
        clearStartError,
    };

    return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useSocket = () => useContext(SocketContext);

/**
 * Joins a server-side room while the calling page is mounted (and again after
 * reconnects) and listens to its events. The server only produces data for
 * rooms that have members.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useRoom = (room, handlers) => {
    const { socket } = useSocket();
    const handlerRef = useRef(handlers);
    useEffect(() => {
        handlerRef.current = handlers;
    });
    const events = Object.keys(handlers).join(',');

    useEffect(() => {
        if (!socket) return undefined;
        const listeners = events.split(',').filter(Boolean).map((event) => {
            const listener = (...args) => handlerRef.current[event]?.(...args);
            socket.on(event, listener);
            return [event, listener];
        });
        const join = () => socket.emit(`${room}_subscribe`);
        socket.on('connect', join);
        join();
        return () => {
            socket.emit(`${room}_unsubscribe`);
            socket.off('connect', join);
            for (const [event, listener] of listeners) socket.off(event, listener);
        };
    }, [socket, room, events]);
};

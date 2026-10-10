const { EventEmitter } = require('events');
const { JsonStore } = require('./store');

const MAX_EVENTS = 300;
const MAX_REQUESTS = 50;
const NAME = '[A-Za-z0-9_]{1,16}';

// "[12:34:56] [Server thread/INFO]: message" (some loaders add a logger name after the level).
const LINE = /^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]+)\/(INFO|WARN|ERROR)\](?: \[[^\]]+\])?: (.*)$/;
const CHAT = new RegExp(`^(?:\\[Not Secure\\] )?<(${NAME})> (.*)$`);
const SAY = /^(?:\[Not Secure\] )?\[(Server|Rcon)\] (.*)$/;
const JOIN = new RegExp(`^(${NAME}) joined the game$`);
const LEAVE = new RegExp(`^(${NAME}) left the game$`);
const ADVANCEMENT = new RegExp(`^(${NAME}) has (?:made the advancement|completed the challenge|reached the goal) \\[(.+)\\]$`);
const NOT_WHITELISTED = /not white-?listed/i;
// Server messages that start with a player's name but are not deaths.
const NOT_DEATH = /^(?:\S+ (?:lost connection|logged in with entity id|issued server command|moved too quickly|moved wrongly|was kicked|left the game|joined the game|has (?:made|completed|reached))|\S+\[)/;

/**
 * Turns server log lines into chat, join/leave, death and advancement events
 * for the Comms page, and remembers refused (non-whitelisted) logins as join
 * requests for Personnel. Parsing is a few regexes per line.
 */
class LogEvents extends EventEmitter {
    constructor({ minecraft, requestsFile }) {
        super();
        this.events = [];
        this.known = new Set();
        this.requests = requestsFile ? new JsonStore(requestsFile, { requests: [] }) : null;
        if (minecraft) minecraft.on('line', (line) => this.handleLine(line));
    }

    static parse(line, known = new Set()) {
        const match = LINE.exec(line);
        if (!match) return null;
        const [, time, thread, level, message] = match;
        if (NOT_WHITELISTED.test(message)) return LogEvents.refused(time, message);
        if (level !== 'INFO' || !/^(Server thread|Async Chat Thread)/.test(thread)) return null;
        let m;
        if ((m = CHAT.exec(message))) return { type: 'chat', time, name: m[1], message: m[2] };
        if ((m = SAY.exec(message))) return { type: 'chat', time, name: m[1] === 'Rcon' ? 'Console' : 'Server', message: m[2], system: true };
        if ((m = JOIN.exec(message))) return { type: 'join', time, name: m[1] };
        if ((m = LEAVE.exec(message))) return { type: 'leave', time, name: m[1] };
        if ((m = ADVANCEMENT.exec(message))) return { type: 'advancement', time, name: m[1], message: m[2] };
        const first = message.split(' ', 1)[0];
        if (known.has(first) && message.length > first.length + 1 && !NOT_DEATH.test(message)) {
            return { type: 'death', time, name: first, message: message.slice(first.length + 1) };
        }
        return null;
    }

    /**
     * Refused logins look like "Disconnecting Name (/ip:port): ...",
     * "Name (/ip:port) lost connection: ..." or a GameProfile dump with name=Name.
     */
    static refused(time, message) {
        const name = (/name=([A-Za-z0-9_]{1,16})\b/.exec(message) || /^(?:Disconnecting )?([A-Za-z0-9_]{1,16})\b/.exec(message) || [])[1];
        if (!name || name === 'com') return null;
        const ip = (/\(\/([0-9a-f.:]+?)(?::\d+)?\)/i.exec(message) || [])[1] || null;
        return { type: 'refused', time, name, ip };
    }

    handleLine(line) {
        const event = LogEvents.parse(line, this.known);
        if (!event) return;
        if (event.type === 'join') this.known.add(event.name);
        if (event.type === 'refused') this.recordRequest(event);
        this.push(event);
    }

    push(event) {
        const full = { at: Date.now(), ...event };
        this.events.push(full);
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
        this.emit('event', full);
        return full;
    }

    history() {
        return this.events;
    }

    recordRequest({ name, ip }) {
        if (!this.requests) return;
        this.requests.update((draft) => {
            const existing = draft.requests.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
            if (existing) {
                existing.lastAt = Date.now();
                existing.count = (existing.count || 1) + 1;
                if (ip) existing.ip = ip;
            } else {
                draft.requests.push({ name, ip: ip || null, firstAt: Date.now(), lastAt: Date.now(), count: 1 });
            }
            draft.requests = draft.requests.sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_REQUESTS);
        });
        this.emit('requests');
    }

    listRequests() {
        return this.requests ? this.requests.get().requests : [];
    }

    dismissRequest(name) {
        if (!this.requests) return;
        this.requests.update((draft) => {
            draft.requests = draft.requests.filter((entry) => entry.name.toLowerCase() !== String(name).toLowerCase());
        });
        this.emit('requests');
    }
}

module.exports = { LogEvents };

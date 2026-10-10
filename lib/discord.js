const crypto = require('crypto');
const { execFile } = require('child_process');
const { OperationError } = require('./operations');

const WEBHOOK_PATTERN = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
const DEBOUNCE_MS = 3000;
const STATUS_STYLE = {
    ONLINE: { emoji: '🟢', color: 0x22c55e, label: 'Online' },
    STARTING: { emoji: '🟡', color: 0xeab308, label: 'Starting' },
    STOPPING: { emoji: '🟡', color: 0xeab308, label: 'Stopping' },
    OFFLINE: { emoji: '🔴', color: 0xef4444, label: 'Offline' },
    UNCONFIGURED: { emoji: '⚪', color: 0x64748b, label: 'Not installed' },
};

const hash = (value) => crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex');
const maskWebhook = (url) => (url ? `${url.slice(0, url.lastIndexOf('/') + 1)}…${url.slice(-4)}` : '');
const loaderName = (loader) => (loader === 'forge' ? 'Forge' : 'Fabric');

/** Tailscale IPv4 of this machine, or null. */
const detectTailscaleIp = () => new Promise((resolve) => {
    const exe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
    execFile(exe, ['ip', '-4'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        resolve(error ? null : (stdout.trim().split(/\r?\n/)[0] || null));
    });
});

/** Keeps a player guide and a live status card in a Discord channel through a webhook. */
class DiscordSync {
    constructor({ config, state, minecraft, worlds, players, modpack, fetchImpl = fetch }) {
        this.config = config;
        this.state = state;
        this.minecraft = minecraft;
        this.worlds = worlds;
        this.players = players;
        this.modpack = modpack;
        this.fetchImpl = fetchImpl;
        this.timer = null;
        this.running = null;
        this.pending = false;
    }

    settings() {
        return this.state.get().discord || {};
    }

    saveSettings(patch) {
        this.state.update((draft) => {
            draft.discord = { ...(draft.discord || {}), ...patch };
        });
        return this.settings();
    }

    packToken() {
        let token = this.settings().packToken;
        if (!token) token = this.saveSettings({ packToken: crypto.randomBytes(16).toString('hex') }).packToken;
        return token;
    }

    /** One-click setup for players' games, when the active setup can be synced automatically. */
    clientSetup() {
        const base = (this.settings().baseUrl || '').replace(/\/+$/, '');
        const cs = this.clientSync;
        const { profile, activeSetupId } = this.state.get();
        if (!cs || !base || !profile || !activeSetupId || profile.loader !== 'fabric' || !profile.loaderVersion || !cs.agentInfo()) return null;
        const token = this.packToken();
        return {
            url: `${base}/client/${token}/${cs.brand().setupFile}`,
            fileName: cs.brand().setupFile,
            command: cs.setupCommand(base, token),
            label: cs.label(activeSetupId, profile),
        };
    }

    packUrl() {
        const base = (this.settings().baseUrl || '').replace(/\/+$/, '');
        return base ? `${base}/pack/${this.packToken()}/${this.modpack.fileName()}` : null;
    }

    publicView() {
        const s = this.settings();
        return {
            enabled: Boolean(s.enabled),
            webhookConfigured: Boolean(s.webhookUrl),
            webhookUrl: maskWebhook(s.webhookUrl),
            baseUrl: s.baseUrl || '',
            gameAddress: s.gameAddress || '',
            inviteUrl: s.inviteUrl || '',
            serverName: s.serverName || 'Minecraft server',
            postTitle: s.postTitle || '',
            forum: Boolean(s.forum),
            threadId: s.threadId || null,
            postUrl: s.threadId && s.guildId ? `https://discord.com/channels/${s.guildId}/${s.threadId}` : null,
            packUrl: this.packUrl(),
            lastSyncAt: s.lastSyncAt || null,
            lastError: s.lastError || null,
        };
    }

    postTitle() {
        const s = this.settings();
        return (s.postTitle || `Minecraft — ${s.serverName || 'server'}`).slice(0, 100);
    }

    async defaults() {
        const ip = await detectTailscaleIp();
        return ip ? { baseUrl: `http://${ip}:${this.config.PORT}`, gameAddress: `${ip}:25565` } : {};
    }

    async update(input = {}) {
        const patch = {};
        if (input.webhookUrl !== undefined && input.webhookUrl !== '') {
            const url = String(input.webhookUrl).trim();
            if (!WEBHOOK_PATTERN.test(url)) throw new OperationError('That is not a Discord webhook URL.', { code: 'INVALID_WEBHOOK' });
            if (url !== this.settings().webhookUrl) {
                Object.assign(patch, { webhookUrl: url, guideMessageId: null, statusMessageId: null, threadId: null, forum: false, hashes: {} });
            }
        }
        if (input.existingPost !== undefined && input.existingPost !== '') {
            // A forum post link (…/channels/<guild>/<thread>) or a bare thread id.
            const match = /(?:channels\/(\d+)\/)?(\d{15,25})\/?$/.exec(String(input.existingPost).trim());
            if (!match) throw new OperationError('Paste a forum post link or its ID.', { code: 'INVALID_SETTING' });
            Object.assign(patch, { forum: true, threadId: match[2], guildId: match[1] || this.settings().guildId || null, guideMessageId: null, statusMessageId: null, hashes: {} });
        }
        for (const key of ['baseUrl', 'gameAddress', 'inviteUrl', 'serverName', 'postTitle']) {
            if (input[key] === undefined) continue;
            const value = String(input[key]).trim();
            if (value.length > 200 || /[\r\n]/.test(value)) throw new OperationError(`Invalid ${key}.`, { code: 'INVALID_SETTING' });
            if (key === 'baseUrl' && value && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(value)) {
                throw new OperationError('Manager address must look like http://100.64.0.10:3000', { code: 'INVALID_SETTING' });
            }
            if (key === 'inviteUrl' && value && !/^https:\/\//.test(value)) {
                throw new OperationError('The invite link must start with https://', { code: 'INVALID_SETTING' });
            }
            patch[key] = value;
        }
        if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
        this.saveSettings(patch);
        if (this.settings().enabled) this.schedule();
        return this.publicView();
    }

    regenerateLink() {
        this.saveSettings({ packToken: crypto.randomBytes(16).toString('hex') });
        this.schedule();
        return this.publicView();
    }

    isValidToken(token) {
        const expected = this.settings().packToken;
        if (!expected || typeof token !== 'string' || token.length !== expected.length) return false;
        return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    }

    /** Coalesces bursts of events (status flips, job completions) into one sync. */
    schedule() {
        const s = this.settings();
        if (!s.enabled || !s.webhookUrl) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.sync().catch(() => {});
        }, DEBOUNCE_MS);
        this.timer.unref?.();
    }

    async sync({ force = false } = {}) {
        if (this.running) {
            this.pending = true;
            return this.running;
        }
        this.running = this.doSync(force)
            .then(() => this.saveSettings({ lastSyncAt: new Date().toISOString(), lastError: null }))
            .catch((error) => {
                console.error('Discord sync failed:', error.message);
                this.saveSettings({ lastError: error.message });
                throw error;
            })
            .finally(() => {
                this.running = null;
                if (this.pending) {
                    this.pending = false;
                    this.schedule();
                }
            });
        return this.running;
    }

    async doSync(force) {
        const s = this.settings();
        if (!s.webhookUrl) throw new OperationError('Add a Discord webhook URL first.', { code: 'NO_WEBHOOK' });
        const pack = await this.modpack.build();
        const view = this.view(pack);

        await this.upsert('guideMessageId', this.guideMessage(view), force);
        await this.upsert('statusMessageId', this.statusMessage(view), force);

        const previous = s.lastMods;
        const context = `${view.world?.id || ''}|${view.profile ? `${view.profile.loader}-${view.profile.minecraftVersion}` : ''}`;
        const switched = Boolean(s.lastContext) && s.lastContext !== context;
        const modsChanged = Boolean(previous && s.lastFingerprint && s.lastFingerprint !== pack.fingerprint);
        if (switched || modsChanged) {
            const notice = this.changeNotice(previous || [], pack.mods, view, { switched });
            if (notice) await this.replaceNotice(notice);
        }
        this.saveSettings({
            lastContext: context,
            lastFingerprint: pack.fingerprint,
            lastMods: pack.mods.map((mod) => ({ projectId: mod.projectId, title: mod.title, versionNumber: mod.versionNumber })),
        });
    }

    view(pack) {
        const s = this.settings();
        const profile = this.state.get().profile;
        const activeId = this.worlds.activeId();
        const world = activeId ? this.worlds.list().find((entry) => entry.id === activeId) : null;
        return {
            serverName: s.serverName || 'Minecraft server',
            inviteUrl: s.inviteUrl || '',
            gameAddress: s.gameAddress || '(ask an admin)',
            packUrl: this.packUrl(),
            setup: this.clientSetup(),
            profile,
            world,
            status: this.minecraft.status,
            players: this.players.count(),
            mods: pack.mods,
        };
    }

    guideMessage(view) {
        const version = view.profile
            ? `${loaderName(view.profile.loader)} for Minecraft ${view.profile.minecraftVersion}`
            : 'the server\'s Minecraft version (not installed yet)';
        const mc = view.profile?.minecraftVersion || '';
        const tailscale = `**1. Join our Tailscale network** — install Tailscale (<https://tailscale.com/download>) and sign in${view.inviteUrl ? ` with this invite: <${view.inviteUrl}>` : '; ask an admin for an invite'}. Keep Tailscale connected while you play.`;
        const fence = '```';
        const oneClick = view.setup && [
            tailscale,
            `**2. Run the one-click setup (once)** — press **Win + R**, paste this and press Enter:\n${fence}\n${view.setup.command}\n${fence}Or download **[⬇️ ${view.setup.fileName}](${view.setup.url})** and open it (if SmartScreen asks: More info → Run anyway).`,
            `**3. Play** — open your launcher (TLauncher, SKLauncher, …), pick **${view.setup.label}** and press Play. Mods install and update themselves every time you press Play, and the server is already in your Multiplayer list.`,
            '**Server changed?** Nothing to reinstall: pick the launcher entry named in the latest notice. Your own mods, versions and shaders are never touched.',
            ...(view.mods.length ? ['_Prefer doing it by hand? Use the mods zip on the server card below._'] : []),
        ];
        const steps = oneClick || (view.mods.length
            ? [
                tailscale,
                `**2. Install ${version}** in your launcher.\n• SKLauncher: Versions → Fabric → ${mc || 'the version above'}\n• TLauncher: pick "Fabric ${mc}" from the version list\n• Other launchers: use the Fabric installer <https://fabricmc.net/use/installer/>`,
                '**3. Download the mods** from the server card below (the link only works while Tailscale is connected).',
                '**4. Install them** — open your game folder (`%appdata%\\.minecraft`), empty the `mods` folder (move old mods somewhere safe), and unzip the download into `mods`.',
                `**5. Play** — start the ${view.profile ? loaderName(view.profile.loader) : ''} ${mc} version → Multiplayer → Add Server → \`${view.gameAddress}\`.`,
                '**Server changed?** You will see a notice here — follow it to switch version or replace your mods.',
            ]
            : [
                tailscale,
                `**2. Start Minecraft ${mc || '(see the server card)'}** — plain Minecraft works, no mods needed. If you use a Fabric profile, empty its \`mods\` folder first.`,
                `**3. Play** — Multiplayer → Add Server → \`${view.gameAddress}\`.`,
                '**Server changed?** You will see a notice here — follow it to switch version or install mods.',
            ]);
        return {
            username: view.serverName,
            embeds: [{
                title: `📖 How to join ${view.serverName}`,
                description: steps.join('\n\n'),
                color: 0x06b6d4,
            }],
        };
    }

    statusMessage(view) {
        const style = STATUS_STYLE[view.status] || STATUS_STYLE.OFFLINE;
        const modLines = view.mods.map((mod) => `• ${mod.title} \`${mod.versionNumber}\``);
        let modsText = modLines.join('\n') || 'No mods — vanilla client is fine.';
        if (modsText.length > 1000) modsText = `${modLines.slice(0, 20).join('\n')}\n…and ${modLines.length - 20} more (all in the zip)`;
        const zip = view.mods.length && view.packUrl ? ` · [mods zip (manual)](${view.packUrl})` : '';
        const download = view.setup
            ? `**Setup (once):** Win + R →\n\`${view.setup.command}\`\nor [⬇️ ${view.setup.fileName}](${view.setup.url})${zip}\nThen pick **${view.setup.label}** in your launcher. Needs Tailscale connected.`
            : !view.mods.length
            ? `**No mods needed** — join with plain Minecraft ${view.profile?.minecraftVersion || ''}.`
            : view.packUrl
                ? `**[⬇️ Download all mods (.zip)](${view.packUrl})**\nOnly works while connected to Tailscale.`
                : '_Download link not configured yet._';
        return {
            username: view.serverName,
            embeds: [{
                title: `${style.emoji} ${view.serverName} — ${style.label}`,
                description: download,
                color: style.color,
                fields: [
                    { name: 'World', value: view.world ? view.world.name : '—', inline: true },
                    { name: 'Version', value: view.profile ? `${loaderName(view.profile.loader)} · Minecraft ${view.profile.minecraftVersion}` : '—', inline: true },
                    { name: 'Players online', value: view.status === 'ONLINE' ? String(view.players) : '—', inline: true },
                    { name: 'Address', value: `\`${view.gameAddress}\``, inline: false },
                    { name: `Mods (${view.mods.length})`, value: modsText, inline: false },
                ],
                timestamp: new Date().toISOString(),
                footer: { text: 'Updated automatically by MC Manager' },
            }],
        };
    }

    changeNotice(previous, mods, view, { switched = false } = {}) {
        const before = new Map(previous.map((mod) => [mod.projectId, mod]));
        const after = new Map(mods.map((mod) => [mod.projectId, mod]));
        const lines = [];
        for (const mod of mods) {
            const old = before.get(mod.projectId);
            if (!old) lines.push(`➕ ${mod.title} \`${mod.versionNumber}\``);
            else if (old.versionNumber !== mod.versionNumber) lines.push(`⬆️ ${mod.title} \`${old.versionNumber}\` → \`${mod.versionNumber}\``);
        }
        for (const mod of previous) if (!after.has(mod.projectId)) lines.push(`➖ ${mod.title}`);
        if (!switched && !lines.length) return null;

        const download = view.packUrl && mods.length ? `\n[⬇️ Download all mods](${view.packUrl})` : '';
        if (switched) {
            const version = view.profile ? `${loaderName(view.profile.loader)} ${view.profile.minecraftVersion}` : 'no setup';
            const modsLine = view.setup
                ? `In your launcher pick **${view.setup.label}**; mods sync automatically when you press Play. (New here? Run the setup from the guide first.)`
                : mods.length
                ? `Use **${version}** in your launcher and replace your \`mods\` folder with the new pack.`
                : `Use **${version}** (or plain Minecraft ${view.profile?.minecraftVersion || ''}) — no mods needed; empty your \`mods\` folder.`;
            return {
                username: view.serverName,
                content: `🌍 **Now running ${view.world ? `"${view.world.name}"` : 'a different world'} on ${version}.**\n${modsLine}${lines.length ? `\n${lines.join('\n')}` : ''}${download}`,
            };
        }
        if (view.setup) {
            return {
                username: view.serverName,
                content: `🔄 **Mods updated** — they install automatically next time you press Play on **${view.setup.label}**.\n${lines.join('\n')}`,
            };
        }
        return {
            username: view.serverName,
            content: `🔄 **Mods updated** — download the new pack and replace your \`mods\` folder before joining.\n${lines.join('\n')}${download}`,
        };
    }

    /**
     * Edits the stored message if its content changed. A deleted message is
     * reposted; in a forum, a deleted post is recreated with the guide as its
     * opening message.
     */
    async upsert(key, payload, force) {
        const s = this.settings();
        const contentHash = hash({ ...payload, embeds: payload.embeds?.map(({ timestamp, ...embed }) => embed) });
        const id = s[key];
        if (id && !force && s.hashes?.[key] === contentHash) return;

        let message = null;
        if (id) {
            try {
                message = await this.send('PATCH', `/messages/${id}`, payload, { thread: true });
            } catch (error) {
                if (error.discordCode === 10003) this.forgetThread();
                else if (error.discordCode !== 10008 && error.httpStatus !== 404) throw error;
            }
        }
        if (!message) message = await this.post(payload, { opening: key === 'guideMessageId' });
        this.saveSettings({ [key]: message.id, hashes: { ...(this.settings().hashes || {}), [key]: contentHash } });
    }

    /**
     * Posts a change notice (so followers get notified) and deletes the previous
     * one, keeping the post to guide, status card and the latest change.
     */
    async replaceNotice(payload) {
        const previous = this.settings().noticeMessageId;
        const message = await this.post(payload);
        this.saveSettings({ noticeMessageId: message.id });
        if (!previous) return;
        try {
            await this.send('DELETE', `/messages/${previous}`, null, { thread: true });
        } catch (error) {
            if (error.discordCode !== 10008 && error.httpStatus !== 404) console.error('Could not delete the old notice:', error.message);
        }
    }

    forgetThread() {
        this.saveSettings({ threadId: null, guideMessageId: null, statusMessageId: null, noticeMessageId: null, hashes: {} });
    }

    /**
     * Posts a message. Plain channels just receive it; forum channels need a post
     * (thread): the first message creates it, the rest go into it.
     */
    async post(payload, { opening = false } = {}) {
        const s = this.settings();
        if (s.forum && s.threadId) {
            try {
                return await this.send('POST', '', payload, { thread: true });
            } catch (error) {
                if (error.discordCode !== 10003) throw error;
                this.forgetThread();
                return this.post(payload, { opening });
            }
        }
        if (s.forum) return this.createPost(payload);
        try {
            return await this.send('POST', '', payload);
        } catch (error) {
            // 220001: webhooks in forum channels must create or target a post.
            if (error.discordCode !== 220001) throw error;
            this.saveSettings({ forum: true });
            return this.createPost(payload);
        }
    }

    async createPost(payload) {
        const message = await this.send('POST', '', { ...payload, thread_name: this.postTitle() });
        // The new post's thread id is the channel id of its opening message.
        this.saveSettings({ threadId: message.channel_id, guildId: message.guild_id || this.settings().guildId || null, statusMessageId: null });
        return message;
    }

    async send(method, suffix, payload, { thread = false } = {}) {
        const s = this.settings();
        const params = new URLSearchParams({ wait: 'true' });
        if (thread && s.forum && s.threadId) params.set('thread_id', s.threadId);
        const url = `${s.webhookUrl}${suffix}?${params}`;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const res = await this.fetchImpl(url, {
                method,
                headers: payload ? { 'content-type': 'application/json' } : {},
                body: payload ? JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }) : undefined,
            });
            if (res.status === 429) {
                const retry = Number((await res.json().catch(() => ({}))).retry_after || 1);
                await new Promise((resolve) => setTimeout(resolve, Math.min(10, retry) * 1000));
                continue;
            }
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                let discordCode = null;
                try {
                    discordCode = JSON.parse(text).code ?? null;
                } catch {
                    discordCode = null;
                }
                const error = new OperationError(`Discord rejected the update (HTTP ${res.status}): ${text.slice(0, 200)}`, { code: 'DISCORD_ERROR', status: 502 });
                error.discordCode = discordCode;
                error.httpStatus = res.status;
                throw error;
            }
            return res.status === 204 ? null : res.json();
        }
        throw new OperationError('Discord rate limit; try again shortly.', { code: 'DISCORD_RATE_LIMIT', status: 502 });
    }
}

module.exports = { DiscordSync, WEBHOOK_PATTERN, detectTailscaleIp };

import React, { useState, useEffect } from 'react';
import { Save, Settings as SettingsIcon, RotateCcw } from 'lucide-react';

const Settings = () => {
    const [properties, setProperties] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);

    useEffect(() => {
        fetchProperties();
    }, []);

    const fetchProperties = async () => {
        try {
            const res = await fetch('/api/properties');
            if (res.ok) {
                const data = await res.json();
                setProperties(data);
            }
        } catch (e) {
            console.error('Failed to load properties', e);
        } finally {
            setLoading(false);
        }
    };

    const handleChange = (key, value) => {
        setProperties(prev => ({ ...prev, [key]: value }));
    };

    const handleSave = async () => {
        setSaving(true);
        setMessage(null);
        try {
            const res = await fetch('/api/properties', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(properties)
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Settings saved successfully. Restart server to apply.' });
            } else {
                setMessage({ type: 'error', text: 'Failed to save settings.' });
            }
        } catch (e) {
            setMessage({ type: 'error', text: 'Error saving settings.' });
        } finally {
            setSaving(false);
        }
    };

    // Important keys to show at the top
    const PRIORITY_KEYS = ['server-port', 'max-players', 'view-distance', 'simulation-distance', 'difficulty', 'gamemode', 'level-name', 'motd', 'white-list', 'online-mode', 'pvp', 'allow-flight'];

    if (loading) return <div className="p-8 text-slate-500">Loading configuration...</div>;

    const sortedKeys = Object.keys(properties).sort((a, b) => {
        const aP = PRIORITY_KEYS.indexOf(a);
        const bP = PRIORITY_KEYS.indexOf(b);
        if (aP !== -1 && bP !== -1) return aP - bP;
        if (aP !== -1) return -1;
        if (bP !== -1) return 1;
        return a.localeCompare(b);
    });

    return (
        <div className="h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col">
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <SettingsIcon className="w-4 h-4 text-slate-500" />
                    <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">Server Configuration</span>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={fetchProperties}
                        className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
                        title="Reload"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-2 px-3 py-1 bg-cyan-600 text-white text-xs font-bold rounded hover:bg-cyan-500 transition-colors disabled:opacity-50"
                    >
                        <Save className="w-3 h-3" />
                        {saving ? 'SAVING...' : 'SAVE CHANGES'}
                    </button>
                </div>
            </div>

            {message && (
                <div className={`p-3 text-sm font-mono text-center ${message.type === 'success' ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                    {message.text}
                </div>
            )}

            <div className="p-6 overflow-auto">
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {sortedKeys.map(key => (
                        <div key={key} className="group">
                            <label className="block text-xs font-mono text-slate-500 mb-1 group-hover:text-cyan-400 transition-colors">{key}</label>
                            <input
                                type="text"
                                value={properties[key]}
                                onChange={(e) => handleChange(key, e.target.value)}
                                className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-slate-200 text-sm font-mono focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-all"
                            />
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default Settings;

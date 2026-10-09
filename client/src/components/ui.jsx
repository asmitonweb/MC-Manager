import React from 'react';

// Small shared building blocks in the dashboard's slate/cyan style.

export const Panel = ({ title, icon: Icon, actions, children, className = '' }) => (
    <div className={`bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-xl flex flex-col ${className}`}>
        {(title || actions) && (
            <div className="bg-slate-950 p-3 border-b border-slate-800 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    {Icon && <Icon className="w-4 h-4 text-slate-500 shrink-0" />}
                    <span className="text-xs font-mono text-slate-400 uppercase tracking-widest truncate">{title}</span>
                </div>
                {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
            </div>
        )}
        <div className="p-4 md:p-6 overflow-auto flex-1">{children}</div>
    </div>
);

const BUTTON_STYLES = {
    primary: 'bg-cyan-600 text-white hover:bg-cyan-500',
    secondary: 'bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700',
    danger: 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/30',
    ghost: 'text-slate-400 hover:text-white hover:bg-slate-800',
};

export const Button = ({ variant = 'primary', icon: Icon, children, className = '', ...props }) => (
    <button
        type="button"
        {...props}
        className={`inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-wider rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    >
        {Icon && <Icon className="w-4 h-4" />}
        {children}
    </button>
);

export const Field = ({ label, hint, children }) => (
    <label className="block">
        <span className="block text-xs font-mono text-slate-500 mb-1 uppercase tracking-wider">{label}</span>
        {children}
        {hint && <span className="block text-xs text-slate-500 mt-1">{hint}</span>}
    </label>
);

export const Notice = ({ tone = 'info', children }) => {
    const tones = {
        info: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300',
        warn: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300',
        error: 'bg-red-500/10 border-red-500/30 text-red-300',
        success: 'bg-green-500/10 border-green-500/30 text-green-300',
    };
    return <div className={`border rounded-lg px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
};

export const Modal = ({ title, onClose, children, footer }) => (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
        <div
            className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
            onClick={(event) => event.stopPropagation()}
        >
            <div className="px-5 py-4 border-b border-slate-800 text-white font-bold">{title}</div>
            <div className="p-5 overflow-auto space-y-4">{children}</div>
            {footer && <div className="px-5 py-4 border-t border-slate-800 flex justify-end gap-2">{footer}</div>}
        </div>
    </div>
);

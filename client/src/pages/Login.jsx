import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { Lock, Server } from 'lucide-react';

const Login = () => {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const { login } = useAuth();
    const navigate = useNavigate();

    const handleSubmit = async (e) => {
        e.preventDefault();
        const success = await login(password);
        if (success) {
            navigate('/');
        } else {
            setError('Access Denied');
        }
    };

    return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-200 font-sans">
            <div className="w-full max-w-md p-8 bg-slate-900/50 border border-slate-800 rounded-xl shadow-2xl backdrop-blur-sm">
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-cyan-500/10 mb-4">
                        <Server className="w-8 h-8 text-cyan-400" />
                    </div>
                    <h1 className="text-2xl font-bold text-white tracking-tight">CLOSED ROOM INC.</h1>
                    <p className="text-slate-500 text-sm mt-2 uppercase tracking-widest">MC Server Manager</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                        <label className="block text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">
                            Security Clearance
                        </label>
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <Lock className="h-5 w-5 text-slate-500" />
                            </div>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="block w-full pl-10 pr-3 py-3 bg-slate-950 border border-slate-800 rounded-lg text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition-colors"
                                placeholder="Enter Access Code"
                            />
                        </div>
                    </div>

                    {error && (
                        <div className="text-red-400 text-sm text-center bg-red-500/10 py-2 rounded border border-red-500/20">
                            {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-cyan-500 transition-all duration-200 uppercase tracking-wide"
                    >
                        Authenticate
                    </button>
                </form>

                <div className="mt-8 text-center text-xs text-slate-600">
                    <p>RESTRICTED ACCESS SYSTEM</p>
                    <p>UNAUTHORIZED ACCESS IS PROHIBITED</p>
                </div>
            </div>
        </div>
    );
};

export default Login;

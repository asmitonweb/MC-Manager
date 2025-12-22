import React from 'react';

const MapFrame = () => {
    return (
        <div className="w-full h-full bg-slate-950 relative rounded-xl overflow-hidden border border-slate-800 shadow-xl">
            <div className="absolute inset-0 flex items-center justify-center text-slate-600 z-0">
                <div className="text-center">
                    <div className="animate-spin w-8 h-8 border-4 border-cyan-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                    <p className="text-xs uppercase tracking-widest">Establishing Uplink...</p>
                </div>
            </div>
            <iframe
                src="/map/"
                className="w-full h-full border-0 relative z-10"
                title="BlueMap World Viewer"
                allowFullScreen
            />
        </div>
    );
};

export default MapFrame;

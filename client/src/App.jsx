import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider } from './context/SocketContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Console from './components/Console';
import MapFrame from './components/MapFrame';

import Chat from './components/Chat';
import Players from './components/Players';
import ResourceGraph from './components/Stats/ResourceGraph';
import Settings from './components/Settings/Settings';
import ServerControls from './components/ServerControls';
import Ping from './components/Ping';
import ServerPage from './pages/ServerPage';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex items-center justify-center h-screen bg-slate-950 text-cyan-500">INITIALIZING...</div>;
  if (!user) return <Navigate to="/login" />;
  return children;
};

const AdminRoute = ({ children }) => {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/controls" replace />;
  return children;
};

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={
            <ProtectedRoute>
              <SocketProvider>
                <Dashboard />
              </SocketProvider>
            </ProtectedRoute>
          }>
            {/* Admin Routes */}
            <Route index element={<AdminRoute><Console /></AdminRoute>} />
            <Route path="chat" element={<AdminRoute><Chat /></AdminRoute>} />
            <Route path="players" element={<AdminRoute><Players /></AdminRoute>} />
            <Route path="stats" element={<AdminRoute><ResourceGraph /></AdminRoute>} />
            <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
            <Route path="server" element={<AdminRoute><ServerPage /></AdminRoute>} />

            {/* Shared Routes */}
            <Route path="map" element={<MapFrame />} />
            <Route path="ping" element={<Ping />} />

            {/* User Routes */}
            <Route path="controls" element={<ServerControls />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ChainProvider } from './chain';
import { ToastProvider } from './components/Toast';
import AppShell from './components/shell/AppShell';
import RoleGate from './components/shell/RoleGate';
import PublicChrome from './components/shell/PublicChrome';

import Home from './pages/Home';
import Access from './pages/Access';
import Enrol from './pages/Enrol';
import Unlock from './pages/Unlock';
import Admin from './pages/Admin';
import Doctor from './pages/Doctor';
import Patient from './pages/Patient';
import Auditor from './pages/Auditor';
import Hospital from './pages/Hospital';
import Verify from './pages/Verify';
import Profile from './pages/Profile';

import AdminDashboard from './pages/dashboards/AdminDashboard';
import DoctorDashboard from './pages/dashboards/DoctorDashboard';
import AuditorDashboard from './pages/dashboards/AuditorDashboard';
import PatientDashboard from './pages/dashboards/PatientDashboard';
import HospitalDashboard from './pages/dashboards/HospitalDashboard';

/**
 * Home renders its own full-page design (hero, footer). /access is its own gate
 * screen. /verify is the one public utility, sharing a slim chrome with the
 * dashboard door in the top right.
 *
 * Every console is wrapped twice: RoleGate decides whether this wallet may load
 * the route at all, and AppShell supplies the chrome. A dashboard link is not an
 * authorisation, so the console routes repeat the same gate.
 */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/access" element={<Access />} />
      {/* Creating a wallet, and opening one later. Neither needs an extension —
          they are the whole point of not needing one. */}
      <Route path="/enrol" element={<Enrol />} />
      <Route path="/unlock" element={<Unlock />} />
      <Route
        path="/verify"
        element={
          <PublicChrome>
            <Verify />
          </PublicChrome>
        }
      />

      {/* Dashboards — the landing surface for each role. */}
      <Route
        path="/admin"
        element={
          <RoleGate role="admin">
            <AppShell>
              <AdminDashboard />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/doctor"
        element={
          <RoleGate role="doctor">
            <AppShell>
              <DoctorDashboard />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/auditor"
        element={
          <RoleGate role="auditor">
            <AppShell>
              <AuditorDashboard />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/patient"
        element={
          <RoleGate role="patient">
            <AppShell>
              <PatientDashboard />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/hospital"
        element={
          <RoleGate role="hospital">
            <AppShell>
              <HospitalDashboard />
            </AppShell>
          </RoleGate>
        }
      />

      {/* Operational consoles — where the transactions actually happen. */}
      <Route
        path="/admin/console"
        element={
          <RoleGate role="admin">
            <AppShell>
              <Admin />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/doctor/console"
        element={
          <RoleGate role="doctor">
            <AppShell>
              <Doctor />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/auditor/console"
        element={
          <RoleGate role="auditor">
            <AppShell>
              <Auditor />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/patient/console"
        element={
          <RoleGate role="patient">
            <AppShell>
              <Patient />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/hospital/console"
        element={
          <RoleGate role="hospital">
            <AppShell>
              <Hospital />
            </AppShell>
          </RoleGate>
        }
      />
      <Route
        path="/patient/profile"
        element={
          <RoleGate role="patient">
            <AppShell>
              <Profile />
            </AppShell>
          </RoleGate>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <ChainProvider>
          <AppRoutes />
        </ChainProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}

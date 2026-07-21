import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Lists from './pages/Lists';
import PartTrace from './pages/PartTrace';
import Packing from './pages/Packing';
import PackingMonitor from './pages/PackingMonitor';
import PackingPrintLabel from './pages/PackingPrintLabel';
import Images from './pages/Images';
import MachineStatus from './pages/MachineStatus';
import Maintenance from './pages/Maintenance';
import MasterData from './pages/MasterData';
import MasterDataInspection from './pages/MasterDataInspection';
import LicenseActivation from './pages/LicenseActivation';
import { fetchLicenseStatus } from './lib/api';
import { ToolLifeProvider } from './lib/toolLife';
import { AdminAuthProvider } from './lib/adminAuth';

export default function App() {
  const [licensed, setLicensed] = useState<boolean | null>(null);

  const checkLicense = async () => {
    try {
      const status = await fetchLicenseStatus();
      setLicensed(status.licensed);
    } catch {
      setLicensed(false);
    }
  };

  useEffect(() => {
    checkLicense();
  }, []);

  // Loading state
  if (licensed === null) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-white" />
      </div>
    );
  }

  // Unlicensed - show activation page
  if (!licensed) {
    return <LicenseActivation onActivated={() => setLicensed(true)} />;
  }

  // Licensed - show full app. Print routes render WITHOUT Layout so the
  // sidebar/header don't appear in the printout — the print page has its
  // own clean @page setup.
  return (
    <AdminAuthProvider>
      <ToolLifeProvider>
        <Routes>
          <Route path="/packing/print/:packingNumber" element={<PackingPrintLabel />} />
          <Route
            path="*"
            element={
              <Layout>
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/lists" element={<Lists />} />
                  <Route path="/part-trace" element={<PartTrace />} />
                  <Route path="/packing" element={<Packing />} />
                  <Route path="/packing-live" element={<PackingMonitor />} />
                  <Route path="/images" element={<Images />} />
                  <Route path="/machine-status" element={<MachineStatus />} />
                  <Route path="/maintenance" element={<Maintenance />} />
                  <Route path="/master-data" element={<MasterData />} />
                  <Route path="/master-data/:date/:id" element={<MasterDataInspection />} />
                </Routes>
              </Layout>
            }
          />
        </Routes>
      </ToolLifeProvider>
    </AdminAuthProvider>
  );
}

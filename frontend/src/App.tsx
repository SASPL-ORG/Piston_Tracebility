import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Lists from './pages/Lists';
import PartTrace from './pages/PartTrace';
import Images from './pages/Images';
import Maintenance from './pages/Maintenance';
import LicenseActivation from './pages/LicenseActivation';
import { fetchLicenseStatus } from './lib/api';

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

  // Licensed - show full app
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/lists" element={<Lists />} />
        <Route path="/part-trace" element={<PartTrace />} />
        <Route path="/images" element={<Images />} />
        <Route path="/maintenance" element={<Maintenance />} />
      </Routes>
    </Layout>
  );
}

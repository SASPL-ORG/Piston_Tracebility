import { useState } from 'react';
import { KeyRound, ShieldCheck, AlertCircle, Loader2 } from 'lucide-react';
import { activateLicense } from '../lib/api';

interface LicenseActivationProps {
  onActivated: () => void;
}

export default function LicenseActivation({ onActivated }: LicenseActivationProps) {
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) return;

    setLoading(true);
    setError('');

    try {
      const result = await activateLicense(key.trim());
      if (result.success) {
        onActivated();
      } else {
        setError(result.error || 'Invalid license key');
      }
    } catch {
      setError('Failed to activate license. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="bg-white rounded-2xl p-4 shadow-2xl">
            <img src="/logo.png" alt="Symbiotic Automation Systems" className="h-20 object-contain" />
          </div>
        </div>

        {/* Activation card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="text-center mb-6">
            <div className="inline-flex items-center justify-center w-14 h-14 bg-blue-50 rounded-full mb-4">
              <KeyRound size={28} className="text-blue-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">License Activation</h1>
            <p className="text-sm text-gray-500 mt-2">
              Enter your license key to activate Piston Traceability
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">License Key</label>
              <input
                type="text"
                value={key}
                onChange={(e) => { setKey(e.target.value); setError(''); }}
                placeholder="e.g., ClientName.a1b2c3d4e5f6..."
                className="w-full px-4 py-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                disabled={loading}
                autoFocus
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-red-600 bg-red-50 px-4 py-3 rounded-lg text-sm">
                <AlertCircle size={16} className="shrink-0" />
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !key.trim()}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <ShieldCheck size={18} />
              )}
              {loading ? 'Activating...' : 'Activate License'}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-gray-100 text-center">
            <p className="text-xs text-gray-400">
              Contact Symbiotic Automation Systems to obtain a license key
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-slate-500 mt-6">
          Piston Traceability v2.0
        </p>
      </div>
    </div>
  );
}

import { ImageOff } from 'lucide-react';

export default function Images() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-8 bg-blue-600 rounded-full" />
        <h1 className="text-2xl font-bold text-gray-900">Image Viewer</h1>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-16 text-center">
        <div className="inline-flex items-center justify-center w-20 h-20 bg-gray-100 rounded-full mb-6">
          <ImageOff size={36} className="text-gray-400" />
        </div>
        <h3 className="text-lg font-semibold text-gray-700 mb-2">Image Integration Not Configured</h3>
        <p className="text-sm text-gray-400 max-w-md mx-auto">
          This database schema does not include image data. Contact your administrator to set up image integration with CV-X cameras if needed.
        </p>
      </div>
    </div>
  );
}

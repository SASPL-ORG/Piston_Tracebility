import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ImageOff, RefreshCw } from 'lucide-react';
import ImageGroupView from '../components/ImageGroupView';
import Lightbox from '../components/Lightbox';
import {
  fetchMasterInspection,
  formatMasterDataDate,
  formatTimeOnly,
  ImageGroup,
  ImageItem,
  MasterInspectionResponse,
} from '../lib/api';

interface LightboxState {
  images: ImageItem[];
  index: number;
}

// Per-day master inspection page. URL: /master-data/<YYYY-MM-DD>/<catalogId>.
// Each CV-X capture session of the master piece on this day is rendered
// as a separate "Attempt N — HH:MM:SS" card. Catalog IDs 1-4 yield one
// image per attempt (circlip masters); IDs 5-10 yield 25 (ring masters).
export default function MasterDataInspection() {
  const navigate = useNavigate();
  const { date, id } = useParams<{ date: string; id: string }>();
  const [data, setData] = useState<MasterInspectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const handleImageClick = useCallback((images: ImageItem[], index: number) => {
    setLightbox({ images, index });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!id || !date) return;
    const itemId = parseInt(id, 10);
    if (!Number.isFinite(itemId)) {
      setError('Invalid catalog id');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    fetchMasterInspection(itemId, date)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, date]);

  const dateDisplay = date ? formatMasterDataDate(date) : '';

  return (
    <div className="space-y-6">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={() => navigate('/master-data')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md transition-colors"
        >
          <ArrowLeft size={14} />
          Master Data
        </button>
        <span className="text-gray-300">/</span>
        <span className="text-sm text-gray-500">{dateDisplay}</span>
        <span className="text-gray-300">/</span>
        <h1 className="text-xl font-semibold text-gray-900">
          {loading ? '...' : (data?.catalog.identification ?? 'Unknown')}
        </h1>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
      )}

      {/* Master piece details */}
      {data && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-1 h-6 bg-blue-600 rounded-full" />
            <h2 className="text-lg font-semibold text-gray-800">Master Piece Details</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Identification</p>
              <p className="text-gray-800">{data.catalog.identification}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Inspection Type</p>
              <p className="text-gray-800">
                {data.inspection_type === 'CIRCLIP' ? 'Snap Ring' : 'Ring'} · {data.expected_per_attempt}{' '}
                {data.expected_per_attempt === 1 ? 'image' : 'images'} per attempt
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Inspection Date</p>
              <p className="text-gray-800">{dateDisplay}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Attempts on this date</p>
              <p className="text-gray-800">{data.attempts.length}</p>
            </div>
            <div className="md:col-span-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">DMC (2D Scanner Piston Barcode)</p>
              <p className="text-gray-800 font-mono text-xs break-all">{data.catalog.dmc}</p>
            </div>
          </div>
        </div>
      )}

      {/* Attempts. Each attempt is one CV-X session (= one inspection
          run). Renders the same image grid as the regular Image Viewer,
          but with the custom "Attempt N — HH:MM:SS" header. */}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-16 flex items-center justify-center">
          <RefreshCw size={28} className="animate-spin text-blue-500" />
        </div>
      ) : !data || data.attempts.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <ImageOff size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600">No attempts on {dateDisplay}</h3>
          <p className="text-sm text-gray-400 mt-1">
            CV-X hasn't produced inspection images for this master piece on this date yet.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.attempts.map((att) => {
            // Re-shape the attempt into the ImageGroup contract that the
            // existing ImageGroupView component expects. ring_count is set
            // to the attempt number so OK/NG filters and grid layout work
            // unchanged.
            const group: ImageGroup = {
              inspection_type: data.inspection_type,
              ring_count: att.attempt_no,
              expected: data.expected_per_attempt,
              indexed: att.images.length,
              images: att.images,
            };
            const title = `Attempt ${att.attempt_no} — ${formatTimeOnly(att.captured_at)}`;
            return (
              <ImageGroupView
                key={att.session_folder}
                group={group}
                titleOverride={title}
                onImageClick={handleImageClick}
              />
            );
          })}
        </div>
      )}

      {lightbox && (
        <Lightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(idx) => setLightbox({ images: lightbox.images, index: idx })}
        />
      )}
    </div>
  );
}

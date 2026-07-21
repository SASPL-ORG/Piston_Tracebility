import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, ImageOff, Cpu } from 'lucide-react';
import ImageGroupView from '../components/ImageGroupView';
import Lightbox from '../components/Lightbox';
import {
  fetchPartImages,
  ImageGroup,
  ImageItem,
  groupKey,
} from '../lib/api';

interface LightboxState {
  images: ImageItem[];
  index: number;
}

export default function Images() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dmc, setDmc] = useState(searchParams.get('dmc') || '');
  // searchedDmc starts empty so the auto-load effect below fires on first
  // mount when the URL already has ?dmc=… (deep-link from Part Trace).
  const [searchedDmc, setSearchedDmc] = useState('');
  const [groups, setGroups] = useState<ImageGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [lightbox, setLightbox] = useState<LightboxState | null>(null);

  const groupRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const doSearch = useCallback(async (value: string) => {
    if (!value.trim()) return;
    setSearchedDmc(value.trim());
    setLoading(true);
    setError('');
    setSearched(true);
    try {
      const result = await fetchPartImages(value.trim());
      setGroups(result.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load images');
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-search when ?dmc= is present (e.g. deep-link from Part Trace).
  useEffect(() => {
    const dmcParam = searchParams.get('dmc');
    if (dmcParam && dmcParam !== searchedDmc) {
      setDmc(dmcParam);
      doSearch(dmcParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // After groups render, scroll the matching group into view if requested.
  useEffect(() => {
    if (groups.length === 0) return;
    const inspType = searchParams.get('inspection_type');
    const attempt = searchParams.get('attempt');
    if (!inspType) return;
    const wantRing = inspType.toUpperCase() === 'RING';
    const wantAttempt = attempt ? parseInt(attempt, 10) : null;
    const target = groups.find((g) => {
      if (g.inspection_type === 'CIRCLIP') return !wantRing;
      return wantRing && (wantAttempt === null || g.ring_count === wantAttempt);
    });
    if (!target) return;
    const el = groupRefs.current.get(groupKey(target));
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, [groups, searchParams]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchParams({ dmc: dmc.trim() });
    doSearch(dmc);
  };

  const handleImageClick = useCallback((images: ImageItem[], index: number) => {
    setLightbox({ images, index });
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-8 bg-blue-600 rounded-full" />
        <h1 className="text-2xl font-bold text-gray-900">Image Viewer</h1>
      </div>

      {/* Search */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <form onSubmit={handleSubmit} className="flex gap-3">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={dmc}
              onChange={(e) => setDmc(e.target.value)}
              placeholder="Enter DMC serial number..."
              className="w-full pl-10 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !dmc.trim()}
            className="px-6 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            Search
          </button>
        </form>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-5 py-4 rounded-xl text-sm">{error}</div>
      )}

      {/* Groups */}
      {!loading && searched && groups.length > 0 && (
        <div className="space-y-4">
          {groups.map((g) => (
            <ImageGroupView
              key={groupKey(g)}
              group={g}
              onImageClick={handleImageClick}
              ref={(el) => {
                if (el) groupRefs.current.set(groupKey(g), el);
                else groupRefs.current.delete(groupKey(g));
              }}
            />
          ))}
        </div>
      )}

      {!loading && searched && groups.length === 0 && !error && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <ImageOff size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600">No images for this part</h3>
          <p className="text-sm text-gray-400 mt-1">No entries found for DMC: {searchedDmc}</p>
        </div>
      )}

      {!searched && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
          <Cpu size={48} className="mx-auto text-gray-300 mb-4" />
          <h3 className="text-lg font-medium text-gray-600">Search for a Part</h3>
          <p className="text-sm text-gray-400 mt-1">
            Enter a DMC to view its inspection images, grouped by Snap Ring and Ring attempts.
          </p>
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

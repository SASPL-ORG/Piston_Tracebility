import { useState, useMemo, forwardRef } from 'react';
import { AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { ImageGroup, ImageItem, imageThumbSrc, groupTitle } from '../lib/api';

type FilterMode = 'all' | 'ok' | 'ng';

interface ImageGroupViewProps {
  group: ImageGroup;
  onImageClick: (images: ImageItem[], index: number) => void;
  // Master Data inspection pages render "Attempt N — HH:MM:SS" instead of
  // the default "Circlip Inspection" / "Ring Attempt N" — pass that here.
  titleOverride?: string;
}

const ImageGroupView = forwardRef<HTMLDivElement, ImageGroupViewProps>(function ImageGroupView(
  { group, onImageClick, titleOverride },
  ref,
) {
  const [filter, setFilter] = useState<FilterMode>('all');

  // Cap how many thumbnails render at once. Thumbs are generated lazily by the
  // backend on first request (~135 ms each, vs ~60 ms once cached), so a
  // re-inspected part with 500+ images used to fire 500 cold generations at
  // page load -- ~13 s of spinner, and heavy sharp CPU contention. Rendering a
  // page at a time keeps first paint fast; "Show all" stays one click away.
  const PAGE_SIZE = 48;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const filteredImages = useMemo(() => {
    if (filter === 'ok') return group.images.filter((i) => i.ok_flag === 0);
    if (filter === 'ng') return group.images.filter((i) => i.ok_flag === 1);
    return group.images;
  }, [filter, group.images]);

  // Switching OK/NG/All changes the list, so start again from the first page.
  const visibleImages = useMemo(
    () => filteredImages.slice(0, visibleCount),
    [filteredImages, visibleCount],
  );
  const hiddenCount = filteredImages.length - visibleImages.length;

  const okCount = group.images.filter((i) => i.ok_flag === 0).length;
  const ngCount = group.images.filter((i) => i.ok_flag === 1).length;
  const missing = group.expected - group.indexed;

  return (
    <div ref={ref} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="w-1 h-6 bg-blue-600 rounded-full" />
        <h3 className="text-base font-semibold text-gray-800">{titleOverride ?? groupTitle(group)}</h3>
        <span className="text-sm text-gray-500">
          {group.indexed} / {group.expected}
        </span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
          {okCount} OK
        </span>
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
          {ngCount} NG
        </span>
        {missing > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <AlertCircle size={12} />
            Missing {missing} {missing === 1 ? 'image' : 'images'}
          </span>
        )}
        <div className="ml-auto inline-flex rounded-md border border-gray-200 overflow-hidden">
          {(['all', 'ok', 'ng'] as FilterMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => {
                setFilter(mode);
                setVisibleCount(PAGE_SIZE);
              }}
              className={clsx(
                'px-3 py-1 text-xs font-semibold transition-colors',
                filter === mode
                  ? mode === 'ok'
                    ? 'bg-emerald-600 text-white'
                    : mode === 'ng'
                      ? 'bg-red-600 text-white'
                      : 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50',
              )}
            >
              {mode === 'all' ? 'All' : mode.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {filteredImages.length === 0 ? (
        <div className="py-8 text-center text-sm text-gray-400">
          {group.images.length === 0
            ? 'No images for this group'
            : `No ${filter.toUpperCase()} images in this group`}
        </div>
      ) : (
        <>
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
          {visibleImages.map((img, idx) => (
            <button
              key={img.id}
              onClick={() => onImageClick(filteredImages, idx)}
              className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200 bg-gray-100 hover:border-blue-400 transition-colors"
              title={`Picture ${img.picture_no}`}
            >
              <img
                src={imageThumbSrc(img.id)}
                alt={`Picture ${img.picture_no}`}
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover group-hover:opacity-90 transition-opacity"
              />
              <div
                className={clsx(
                  'absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold leading-none',
                  img.ok_flag === 0 ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white',
                )}
              >
                {img.ok_flag === 0 ? 'OK' : 'NG'}
              </div>
              <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-black/60 text-white leading-none">
                #{img.picture_no}
              </div>
            </button>
          ))}
        </div>
        {hiddenCount > 0 && (
          <div className="mt-3 flex items-center justify-center gap-3">
            <span className="text-xs text-gray-500">
              Showing {visibleImages.length} of {filteredImages.length}
            </span>
            <button
              onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              className="px-3 py-1.5 text-xs font-semibold rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Show {Math.min(PAGE_SIZE, hiddenCount)} more
            </button>
            <button
              onClick={() => setVisibleCount(filteredImages.length)}
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Show all {filteredImages.length}
            </button>
          </div>
        )}
        </>
      )}
    </div>
  );
});

export default ImageGroupView;

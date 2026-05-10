import { useState, useMemo, forwardRef } from 'react';
import { AlertCircle } from 'lucide-react';
import clsx from 'clsx';
import { ImageGroup, ImageItem, imageSrc, groupTitle } from '../lib/api';

type FilterMode = 'all' | 'ok' | 'ng';

interface ImageGroupViewProps {
  group: ImageGroup;
  onImageClick: (images: ImageItem[], index: number) => void;
}

const ImageGroupView = forwardRef<HTMLDivElement, ImageGroupViewProps>(function ImageGroupView(
  { group, onImageClick },
  ref,
) {
  const [filter, setFilter] = useState<FilterMode>('all');

  const filteredImages = useMemo(() => {
    if (filter === 'ok') return group.images.filter((i) => i.ok_flag === 0);
    if (filter === 'ng') return group.images.filter((i) => i.ok_flag === 1);
    return group.images;
  }, [filter, group.images]);

  const missing = group.expected - group.indexed;

  return (
    <div ref={ref} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="w-1 h-6 bg-blue-600 rounded-full" />
        <h3 className="text-base font-semibold text-gray-800">{groupTitle(group)}</h3>
        <span className="text-sm text-gray-500">
          {group.indexed} / {group.expected}
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
              onClick={() => setFilter(mode)}
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
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
          {filteredImages.map((img, idx) => (
            <button
              key={img.id}
              onClick={() => onImageClick(filteredImages, idx)}
              className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200 bg-gray-100 hover:border-blue-400 transition-colors"
              title={`Picture ${img.picture_no}`}
            >
              <img
                src={imageSrc(img.id)}
                alt={`Picture ${img.picture_no}`}
                loading="lazy"
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
      )}
    </div>
  );
});

export default ImageGroupView;

import { useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import clsx from 'clsx';
import { ImageItem, imageSrc } from '../lib/api';

interface LightboxProps {
  images: ImageItem[];
  index: number;
  onClose: () => void;
  onIndexChange: (next: number) => void;
}

export default function Lightbox({ images, index, onClose, onIndexChange }: LightboxProps) {
  const current = images[index];

  const next = useCallback(() => {
    if (images.length === 0) return;
    onIndexChange((index + 1) % images.length);
  }, [images.length, index, onIndexChange]);

  const prev = useCallback(() => {
    if (images.length === 0) return;
    onIndexChange((index - 1 + images.length) % images.length);
  }, [images.length, index, onIndexChange]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, onClose]);

  if (!current) return null;

  const src = imageSrc(current.id);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-3 bg-gradient-to-b from-black/70 to-transparent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 text-white text-sm">
          <span className="font-mono">
            {index + 1} / {images.length}
          </span>
          <span className="text-white/60">·</span>
          <span>Picture {current.picture_no}</span>
          <span
            className={clsx(
              'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold',
              current.ok_flag === 0 ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white',
            )}
          >
            {current.ok_flag === 0 ? 'OK' : 'NG'}
          </span>
          {current.camera_id && <span className="text-white/60 text-xs">{current.camera_id}</span>}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={src}
            download
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-white bg-white/10 hover:bg-white/20 rounded-md transition-colors"
            title="Download image"
          >
            <Download size={14} />
            Download
          </a>
          <button
            onClick={onClose}
            className="p-1.5 text-white bg-white/10 hover:bg-white/20 rounded-md transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Prev */}
      {images.length > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            prev();
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-white bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          aria-label="Previous"
        >
          <ChevronLeft size={28} />
        </button>
      )}

      {/* Image */}
      <img
        src={src}
        alt={`Picture ${current.picture_no}`}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] max-w-[92vw] object-contain shadow-2xl"
      />

      {/* Next */}
      {images.length > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            next();
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-white bg-white/10 hover:bg-white/20 rounded-full transition-colors"
          aria-label="Next"
        >
          <ChevronRight size={28} />
        </button>
      )}
    </div>
  );
}

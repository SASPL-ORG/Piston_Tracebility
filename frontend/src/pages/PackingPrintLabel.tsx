import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Printer, X } from 'lucide-react';
import {
  fetchPackingHistoryDetail,
  type PackingHistoryDetail,
} from '../lib/api';
import { GRADE_BY_PCODE, modelOfPCode } from '../lib/grades';

// Printable pallet label — one A4-ish page per pallet. Reached from the
// "Print & Complete" button in the Packing History modal; auto-triggers
// the browser print dialog ~400 ms after data loads so the operator
// only needs to confirm in the dialog. The on-screen buttons are
// hidden during print via @media print rules so the printout itself
// is clean: just the label content.
//
// The QR encodes the pallet number string verbatim — scan it with any
// reader (the Zebra or a phone) and you get the packing number back.
// No external API: qrcode.react renders an SVG client-side, so this
// works on an air-gapped SCADA box.

export default function PackingPrintLabel() {
  const { packingNumber = '' } = useParams<{ packingNumber: string }>();
  const [rows, setRows] = useState<PackingHistoryDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoPrinted, setAutoPrinted] = useState(false);

  useEffect(() => {
    if (!packingNumber) return;
    fetchPackingHistoryDetail(packingNumber)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [packingNumber]);

  // Auto-fire the print dialog once data is in.
  useEffect(() => {
    if (loading || autoPrinted) return;
    const id = window.setTimeout(() => {
      window.print();
      setAutoPrinted(true);
    }, 400);
    return () => window.clearTimeout(id);
  }, [loading, autoPrinted]);

  const grade = rows[0]?.grade ?? '';
  const gradeCode = GRADE_BY_PCODE.get(grade)?.code ?? '—';
  const modelNumber = grade ? (modelOfPCode(grade) ?? '—') : '—';
  const qty = rows.length;
  const firstPackedAt = rows[0]?.packedAt ?? null;
  const packingDate = formatDate(firstPackedAt);

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white p-6 print:p-0">
      <style>{`
        @media print {
          @page { size: A4; margin: 12mm; }
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>

      {/* Action bar — hidden during print */}
      <div className="max-w-3xl mx-auto mb-4 flex items-center gap-3 print:hidden">
        <h1 className="text-lg font-semibold text-gray-700">Pallet label preview</h1>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
          >
            <Printer size={16} />
            Print
          </button>
          <button
            onClick={() => window.close()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-gray-200 text-gray-700 text-sm font-semibold hover:bg-gray-50"
          >
            <X size={16} />
            Close
          </button>
        </div>
      </div>

      {/* Label — printed area */}
      <div className="max-w-3xl mx-auto bg-white border-2 border-gray-800 print:border-black p-8 shadow-sm print:shadow-none">
        <div className="flex items-start justify-between border-b-2 border-gray-800 print:border-black pb-4 mb-6">
          <div>
            <div className="text-xs uppercase tracking-widest text-gray-500">Packing slip</div>
            <h1 className="text-3xl font-extrabold text-gray-900 leading-tight mt-1">Pallet Label</h1>
          </div>
          <div className="text-right text-xs uppercase tracking-widest text-gray-500">
            Piston Traceability
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Left — fields */}
          <div className="col-span-2 space-y-5">
            <LabelField label="Pallet Number" value={packingNumber} mono large />
            <LabelField label="Model Number" value={modelNumber} />
            <LabelField label="Part Number" value={grade || '—'} mono />
            <LabelField label="Grade" value={gradeCode} />
            <LabelField label="Date of Packing" value={packingDate} />
            <LabelField
              label="Quantity"
              value={loading ? '…' : `${qty} ${qty === 1 ? 'part' : 'parts'}`}
            />
          </div>

          {/* Right — QR. Encodes the pallet number verbatim; any scanner
              decodes it back to the same string. */}
          <div className="flex flex-col items-center justify-start">
            <div className="bg-white p-3 border-2 border-gray-800 print:border-black rounded">
              <QRCodeSVG
                value={packingNumber}
                size={180}
                level="H"
                includeMargin={false}
              />
            </div>
            <div className="text-[10px] text-gray-500 mt-2 text-center">
              Scan to read pallet number
            </div>
            <div className="text-xs font-mono mt-1">{packingNumber}</div>
          </div>
        </div>

      </div>
    </div>
  );
}

function LabelField({
  label,
  value,
  mono,
  large,
}: {
  label: string;
  value: string;
  mono?: boolean;
  large?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 w-40 shrink-0">
        {label}
      </span>
      <span
        className={[
          'font-bold text-gray-900',
          mono ? 'font-mono' : '',
          large ? 'text-3xl tracking-wider' : 'text-xl',
        ].join(' ')}
      >
        {value}
      </span>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
  } catch {
    return iso;
  }
}


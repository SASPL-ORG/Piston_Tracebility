import PDFDocument from 'pdfkit';
import type { Readable } from 'stream';
import { classifyState } from '../db/state.js';
import { serializeDateTime } from '../db/datetime.js';
import type { PartState, SamLogRecord } from '../types/index.js';

const STATE_LABEL: Record<PartState, string> = {
  PACKED: 'Packed',
  RING_OK: 'Ring OK',
  RING_NG: 'Ring Rejected',
  CIRCLIP_SCRAP: 'Circlip Scrap',
  IN_PROGRESS: 'In Progress',
};

function fmt(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${d}-${mo}-${y} ${h}:${mi}:${s}`;
}

export interface PartTracePdfInput {
  dmc: string;
  records: SamLogRecord[];
}

// Returns a Readable stream of the rendered PDF. Caller pipes to the
// Fastify reply.
export function renderPartTracePdf(input: PartTracePdfInput): Readable {
  const { dmc, records } = input;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  const latest = records[records.length - 1];
  const hasCirclipFail = records.some((r) => r.Circlip_Result === 'FAIL');
  const totalAttempts = records.reduce((max, r) => Math.max(max, r.Ring_Count ?? 0), 0);
  const state = classifyState(latest, hasCirclipFail);
  const plant = latest?.Plant_Id ?? '-';
  const firstSeen = records[0]?.Date_Time ?? null;
  const lastSeen = latest?.Date_Time ?? null;

  // ---- Header ----------------------------------------------------------
  doc.fontSize(16).font('Helvetica-Bold').text('Part Traceability Report', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#555');
  doc.text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  doc.fillColor('black').moveDown(0.8);

  // DMC line — break long DMCs across lines so the header doesn't run off.
  doc.fontSize(10).font('Helvetica-Bold').text('DMC:', { continued: true });
  doc.font('Courier').text(`  ${dmc}`);
  doc.moveDown(0.3);

  // ---- Current State ---------------------------------------------------
  doc.moveDown(0.5).fontSize(12).font('Helvetica-Bold').text('Current State');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');
  const summaryRows: [string, string][] = [
    ['State', STATE_LABEL[state]],
    ['Plant', plant],
    ['Total Records', String(records.length)],
    ['Ring Attempts', String(totalAttempts)],
    ['Reinspected', totalAttempts > 1 ? 'Yes' : 'No'],
    ['Latest Circlip', fmt(latest?.Circlip_Result)],
    ['Latest Ring', fmt(latest?.Ring_Result)],
    ['Latest Unload Time', fmt(latest?.Unloading_Time)],
    ['First Seen', fmtDateTime(firstSeen)],
    ['Last Seen', fmtDateTime(lastSeen)],
  ];
  drawTwoColumnTable(doc, summaryRows);

  // ---- Inspection Attempts --------------------------------------------
  doc.moveDown(0.8).fontSize(12).font('Helvetica-Bold').text('Inspection Attempts');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');

  let printedAny = false;
  for (const r of records) {
    if (r.Circlip_Result !== null) {
      drawAttemptLine(doc, {
        kind: 'CIRCLIP',
        attempt: 1,
        result: r.Circlip_Result,
        plcTime: r.Circlip_Time,
        dbTime: fmtDateTime(r.Date_Time),
      });
      printedAny = true;
    }
    if (r.Ring_Result !== null) {
      drawAttemptLine(doc, {
        kind: 'RING',
        attempt: r.Ring_Count ?? 1,
        result: r.Ring_Result,
        plcTime: r.Ring_Time,
        dbTime: fmtDateTime(r.Date_Time),
      });
      printedAny = true;
    }
  }
  if (!printedAny) {
    doc.fillColor('#888').text('No inspection attempts recorded.').fillColor('black');
  }

  // ---- Event Timeline --------------------------------------------------
  doc.moveDown(0.8).fontSize(12).font('Helvetica-Bold').text('Event Timeline');
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica');
  for (const r of records) {
    const overall = fmt(r.Result);
    doc.font('Helvetica-Bold').text(fmtDateTime(r.Date_Time), { continued: true });
    doc.font('Helvetica').text(`   plant=${fmt(r.Plant_Id)}  result=${overall}`);
    doc.text(
      `    Circlip=${fmt(r.Circlip_Result)} (${fmt(r.Circlip_Time)})    ` +
        `Ring=${fmt(r.Ring_Result)} (${fmt(r.Ring_Time)})    ` +
        `Ring Count=${r.Ring_Count ?? '-'}    ` +
        `Unload=${fmt(r.Unloading_Time)}`,
    );
    doc.moveDown(0.3);
  }

  doc.end();
  return doc as unknown as Readable;
}

function drawTwoColumnTable(doc: PDFKit.PDFDocument, rows: [string, string][]): void {
  const labelW = 130;
  for (const [k, v] of rows) {
    const y = doc.y;
    doc.font('Helvetica-Bold').text(k, doc.x, y, { width: labelW, continued: false });
    doc.font('Helvetica').text(v, doc.x + labelW, y, { width: 350 });
    doc.moveDown(0.15);
  }
}

function drawAttemptLine(
  doc: PDFKit.PDFDocument,
  args: {
    kind: 'CIRCLIP' | 'RING';
    attempt: number;
    result: string | null;
    plcTime: string | null;
    dbTime: string;
  },
): void {
  const tag = `[${args.kind} attempt ${args.attempt}]`.padEnd(22, ' ');
  const result = (args.result ?? '-').padEnd(6, ' ');
  doc.font('Courier').text(
    `${tag} ${result}  PLC: ${fmt(args.plcTime).padEnd(20, ' ')}  DB: ${args.dbTime}`,
  );
}

// Re-export to keep the route file lean.
export function deriveSerializedRecords(rawRecords: Array<Record<string, unknown>>): SamLogRecord[] {
  // mssql returns Date_Time as a Date; serialize to ISO with offset so the
  // PDF's Date/Time strings match what the UI shows for the same row.
  return rawRecords.map((r) => ({
    Date_Time: r.Date_Time instanceof Date ? serializeDateTime(r.Date_Time) : (r.Date_Time as string | null),
    Plant_Id: (r.Plant_Id as string) ?? null,
    DMC: (r.DMC as string) ?? null,
    Circlip_Result: (r.Circlip_Result as string) ?? null,
    Circlip_Time: (r.Circlip_Time as string) ?? null,
    Ring_Result: (r.Ring_Result as string) ?? null,
    Ring_Time: (r.Ring_Time as string) ?? null,
    Ring_Count: (r.Ring_Count as number) ?? null,
    Unloading_Time: (r.Unloading_Time as string) ?? null,
    Result: (r.Result as string) ?? null,
  }));
}

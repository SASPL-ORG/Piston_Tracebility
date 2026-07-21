import PDFDocument from 'pdfkit';
import type { Readable } from 'stream';
import { classifyState } from '../db/state.js';
import { serializeDateTime } from '../db/datetime.js';
import type { PartState, SamLogRecord } from '../types/index.js';

const STATE_LABEL: Record<PartState, string> = {
  PACKED: 'Packed',
  COMPLETED: 'Completed',
  RING_OK: 'Ring OK',
  RING_NG: 'Ring Rejected',
  CIRCLIP_SCRAP: 'Snap Ring Scrap',
  IN_PROGRESS: 'In Progress',
};

const COLOR = {
  brand: '#2563eb', // blue accent (matches the UI's left-bar)
  pass: '#059669',
  fail: '#dc2626',
  pending: '#d97706',
  muted: '#6b7280',
  faint: '#9ca3af',
  divider: '#e5e7eb',
};

function fmt(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

// Display-time rename for plant IDs. The DB still stores 'Sam Plant'; we
// show the customer-facing name everywhere in the UI and in PDF reports.
function fmtPlant(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  if (value === 'Sam Plant') return 'IPL Ring Assembly Plant - Anantapur';
  return value;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return iso;
  const [, y, mo, d, h, mi, s] = m;
  return `${d}-${mo}-${y} ${h}:${mi}:${s}`;
}

function resultColor(result: string | null | undefined): string {
  if (result === 'PASS') return COLOR.pass;
  if (result === 'FAIL') return COLOR.fail;
  return COLOR.muted;
}

function stateColor(s: PartState): string {
  if (s === 'PACKED' || s === 'RING_OK') return COLOR.pass;
  if (s === 'IN_PROGRESS') return COLOR.pending;
  return COLOR.fail;
}

// Draws the section title with the same blue left-bar accent the UI uses.
function sectionHeader(doc: PDFKit.PDFDocument, title: string): void {
  const x0 = doc.page.margins.left;
  doc.moveDown(0.4);
  const y = doc.y;
  doc.rect(x0, y, 3, 14).fill(COLOR.brand);
  doc.fillColor('black').font('Helvetica-Bold').fontSize(13).text(title, x0 + 10, y);
  doc.fontSize(10).font('Helvetica');
  doc.x = x0;
  doc.moveDown(0.4);
}

// Two-column key/value list. The fix vs the previous version: doc.x is reset
// to the page's left margin at the START of each row's label call, so labels
// don't drift right as rows are added.
type KvRow = [label: string, value: string, valueColor?: string];

function drawKeyValueTable(doc: PDFKit.PDFDocument, rows: KvRow[]): void {
  const x0 = doc.page.margins.left;
  const labelW = 130;
  const valueX = x0 + labelW;
  const valueW = doc.page.width - doc.page.margins.right - valueX;
  doc.fontSize(10);
  for (const [k, v, color] of rows) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fillColor('black').text(k, x0, y, { width: labelW });
    const yAfterLabel = doc.y;
    // Reset cursor to the row baseline before drawing the value column.
    doc.font('Helvetica').fillColor(color || 'black').text(v, valueX, y, { width: valueW });
    const yAfterValue = doc.y;
    // Advance to whichever column went lower so the next row doesn't overlap.
    doc.y = Math.max(yAfterLabel, yAfterValue);
    doc.x = x0;
    doc.fillColor('black');
  }
}

// One inspection-attempt row, modeled after the on-screen card: colored left
// bar (green/red), kind label, attempt number, bold result, timestamp.
function drawInspectionRow(
  doc: PDFKit.PDFDocument,
  args: {
    kind: 'CIRCLIP' | 'RING';
    attempt: number;
    result: string | null;
    time: string;
  },
): void {
  const x0 = doc.page.margins.left;
  const y = doc.y;
  const color = resultColor(args.result);

  // Colored left bar — tall enough to span the whole row.
  doc.rect(x0, y + 1, 3, 14).fill(color);

  doc.x = x0 + 10;
  doc.fontSize(10).font('Helvetica-Bold').fillColor('black').text(args.kind, { continued: true });
  doc.font('Helvetica').fillColor(COLOR.muted).text(`   Attempt ${args.attempt}   `, { continued: true });
  doc.font('Helvetica-Bold').fillColor(color).text(fmt(args.result), { continued: true });
  doc.font('Helvetica').fillColor(COLOR.muted).text(`     Time: ${args.time}`);
  doc.fillColor('black');
  doc.x = x0;
  doc.moveDown(0.25);
}

// One Event Timeline block — date in colored bold, then two indented detail
// lines. Mirrors the on-screen timeline card.
function drawTimelineRow(doc: PDFKit.PDFDocument, r: SamLogRecord): void {
  const x0 = doc.page.margins.left;
  const isPass = r.Result === 'PASS';
  const color = isPass ? COLOR.pass : COLOR.fail;

  doc.fontSize(10).font('Helvetica-Bold').fillColor(color).text(fmtDateTime(r.Date_Time), x0);
  doc.fontSize(9).font('Helvetica').fillColor(COLOR.muted).text(
    `Plant: ${fmtPlant(r.Plant_Id)}     Result: ${fmt(r.Result)}     Ring Count: ${r.Ring_Count ?? '-'}`,
    x0 + 12,
  );
  doc.fillColor('black').text(
    `Snap Ring: ${fmt(r.Circlip_Result)} (${fmt(r.Circlip_Time)})     ` +
      `Ring: ${fmt(r.Ring_Result)} (${fmt(r.Ring_Time)})     ` +
      `Unload: ${fmt(r.Unloading_Time)}`,
    x0 + 12,
  );
  doc.fontSize(10);
  doc.x = x0;
  doc.moveDown(0.3);
}

export interface PartTracePdfInput {
  dmc: string;
  records: SamLogRecord[];
}

export function renderPartTracePdf(input: PartTracePdfInput): Readable {
  const { dmc, records } = input;
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const x0 = doc.page.margins.left;

  const latest = records[records.length - 1];
  const hasCirclipFail = records.some((r) => r.Circlip_Result === 'FAIL');
  const totalAttempts = records.reduce((max, r) => Math.max(max, r.Ring_Count ?? 0), 0);
  const state = classifyState(latest, hasCirclipFail);

  // ---- Title block ----------------------------------------------------
  doc.fillColor('black').fontSize(20).font('Helvetica-Bold').text('Part Traceability Report', x0);
  doc.moveDown(0.15);
  doc.fontSize(8).font('Helvetica').fillColor(COLOR.faint)
    .text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, x0);
  doc.moveDown(0.4);

  // DMC line — bold label, mono value, allow it to wrap on long DMCs.
  doc.fontSize(10).fillColor('black').font('Helvetica-Bold').text('DMC:', x0, doc.y, { continued: true });
  doc.font('Courier').text(`  ${dmc}`);
  doc.x = x0;

  // ---- Current State --------------------------------------------------
  sectionHeader(doc, 'Current State');
  drawKeyValueTable(doc, [
    ['State', STATE_LABEL[state], stateColor(state)],
    ['Plant', fmtPlant(latest?.Plant_Id)],
    ['Total Records', String(records.length)],
    ['Ring Attempts', String(totalAttempts)],
    ['Reinspected', totalAttempts > 1 ? 'Yes' : 'No'],
    ['Latest Snap Ring', fmt(latest?.Circlip_Result), resultColor(latest?.Circlip_Result)],
    ['Latest Ring', fmt(latest?.Ring_Result), resultColor(latest?.Ring_Result)],
    ['Latest Unload Time', fmt(latest?.Unloading_Time)],
    ['First Seen', fmtDateTime(records[0]?.Date_Time)],
    ['Last Seen', fmtDateTime(latest?.Date_Time)],
  ]);

  // ---- Inspection Attempts -------------------------------------------
  sectionHeader(doc, 'Inspection Attempts');
  let any = false;
  for (const r of records) {
    if (r.Circlip_Result !== null) {
      drawInspectionRow(doc, {
        kind: 'CIRCLIP',
        attempt: 1,
        result: r.Circlip_Result,
        time: fmtDateTime(r.Date_Time),
      });
      any = true;
    }
    if (r.Ring_Result !== null) {
      drawInspectionRow(doc, {
        kind: 'RING',
        attempt: r.Ring_Count ?? 1,
        result: r.Ring_Result,
        time: fmtDateTime(r.Date_Time),
      });
      any = true;
    }
  }
  if (!any) {
    doc.fontSize(10).fillColor(COLOR.muted).text('No inspection attempts recorded.', x0);
    doc.fillColor('black');
  }

  // ---- Event Timeline ------------------------------------------------
  sectionHeader(doc, 'Event Timeline');
  for (const r of records) {
    drawTimelineRow(doc, r);
  }

  doc.end();
  return doc as unknown as Readable;
}

export function deriveSerializedRecords(rawRecords: Array<Record<string, unknown>>): SamLogRecord[] {
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

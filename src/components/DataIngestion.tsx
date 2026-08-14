import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import {
  UploadCloud,
  CheckCircle2,
  XCircle,
  Loader2,
  FileText,
  AlertTriangle,
  Database,
  Info,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useNotificationStore } from '../store';
import type { UploadJob, UploadStatus } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PARSE_LIMIT_MB    = 25;
const PARSE_LIMIT_BYTES = PARSE_LIMIT_MB * 1024 * 1024;
const BATCH_SIZE        = 500;

// ─── File-type detection ──────────────────────────────────────────────────────

type FileKind =
  | 'sales'
  | 'purchases'
  | 'sales_items'
  | 'purchase_items'
  | 'customer_master'
  | 'supplier_master'
  | 'unknown';

// Map FileKind → actual Supabase table name
const TABLE_MAP: Record<FileKind, string> = {
  sales:           'sales',
  purchases:       'purchases',
  sales_items:     'sales_items',
  purchase_items:  'purchase_items',
  customer_master: '',
  supplier_master: '',
  unknown:         '',
};

function detectFileKind(filename: string): FileKind {
  // Normalise to lowercase with single spaces
  const n = filename.toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

  // Master/contact files — check FIRST because "Customers july.csv" and
  // "Suppliers july.csv" would otherwise fall into sales/purchase detection
  if (/^customers?\b/.test(n)) return 'customer_master';
  if (/^suppliers?\b/.test(n)) return 'supplier_master';

  // Item-wise files — check BEFORE plain sales/purchase
  if (/item.*(purchase|po\b)|purchase.*item/i.test(n)) return 'purchase_items';
  if (/item.*sales?|sales?.*item/i.test(n))            return 'sales_items';

  // Invoice-level files
  if (/^purchase\b/.test(n)) return 'purchases';
  if (/^sales?\b/.test(n))   return 'sales';

  return 'unknown';
}

// ─── Column maps ──────────────────────────────────────────────────────────────
// target_column → aliases (lowercase). First match wins.

const COL_MAP: Record<FileKind, Record<string, string[]>> = {
  sales: {
    invoice_date:  ['date', 'invoice date', 'vch date', 'voucher date', 'txn date', 'invoice_date'],
    invoice_no:    ['invoice no', 'invoice no.', 'voucher no', 'vch no', 'vch no.', 'invoice number', 'invoice_no'],
    customer_name: ['party name', 'customer name', 'customer_name', 'party', 'buyer name', 'buyer'],
    product_sku:   ['sku', 'item name', 'item', 'product name', 'product', 'goods', 'item_name', 'product_sku'],
    quantity:      ['qty', 'quantity', 'units', 'qty.'],
    unit_price:    ['rate', 'unit price', 'price', 'unit_price', 'rate per unit'],
    // NOTE: material_type intentionally excluded — column does not exist in the sales table
    total_amount:  ['net amount', 'total amount', 'amount', 'net amt', 'value', 'total', 'total_amount', 'net value'],
  },
  purchases: {
    po_date:       ['date', 'invoice date', 'vch date', 'voucher date', 'po date', 'txn date', 'po_date'],
    invoice_no:    ['invoice no', 'invoice no.', 'voucher no', 'vch no', 'vch no.', 'po no', 'po number', 'invoice_no'],
    vendor_name:   ['party name', 'vendor name', 'supplier name', 'vendor_name', 'supplier_name', 'party', 'vendor', 'supplier'],
    total_amount:  ['net amount', 'total amount', 'amount', 'net amt', 'value', 'total', 'total_amount', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  sales_items: {
    invoice_date:  ['date', 'invoice date', 'vch date', 'voucher date', 'txn date', 'invoice_date'],
    invoice_no:    ['invoice no', 'invoice no.', 'voucher no', 'vch no', 'vch no.', 'invoice_no'],
    customer_name: ['party name', 'customer name', 'customer_name', 'party', 'buyer name', 'buyer'],
    item_name:     ['item name', 'item', 'product name', 'goods', 'description', 'item_name'],
    quantity:      ['qty', 'quantity', 'units', 'qty.'],
    unit:          ['unit', 'uom', 'unit of measure'],
    base_amount:   ['base amount', 'taxable amount', 'taxable amt', 'amount ex gst', 'basic amount', 'taxable value', 'base_amount'],
    gst_amount:    ['gst amount', 'tax amount', 'gst', 'total tax', 'tax', 'gst_amount'],
    total_amount:  ['total amount', 'net amount', 'total', 'net total', 'total value', 'value', 'total_amount', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  purchase_items: {
    invoice_date:  ['date', 'invoice date', 'vch date', 'voucher date', 'txn date', 'invoice_date'],
    invoice_no:    ['invoice no', 'invoice no.', 'voucher no', 'vch no', 'vch no.', 'po no', 'invoice_no'],
    supplier_name: ['party name', 'supplier name', 'vendor name', 'supplier_name', 'vendor_name', 'party', 'supplier', 'vendor'],
    item_name:     ['item name', 'item', 'product name', 'goods', 'description', 'item_name'],
    quantity:      ['qty', 'quantity', 'units', 'qty.'],
    unit:          ['unit', 'uom', 'unit of measure'],
    base_amount:   ['base amount', 'taxable amount', 'taxable amt', 'amount ex gst', 'basic amount', 'taxable value', 'base_amount'],
    gst_amount:    ['gst amount', 'tax amount', 'gst', 'total tax', 'tax', 'gst_amount'],
    total_amount:  ['total amount', 'net amount', 'total', 'net total', 'total value', 'value', 'total_amount', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  customer_master: {},
  supplier_master: {},
  unknown:         {},
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip Indian-style comma formatting and parse to float: "1,25,000.50" → 125000.5 */
function parseNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
}

/** Normalise various date formats to ISO YYYY-MM-DD */
function parseDate(v: unknown): string {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD-MM-YYYY or DD/MM/YYYY (Tally default)
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const day   = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    const year  = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    // If "month" part > 12 the format must be MM/DD — swap
    return parseInt(dmy[2]) > 12
      ? `${year}-${day}-${month}`
      : `${year}-${month}-${day}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

/**
 * Build a target→columnIndex lookup from a header row.
 * Uses the COL_MAP aliases for this FileKind.
 */
function buildColLookup(
  headers: string[],
  map: Record<string, string[]>,
): Record<string, number> {
  const lookup: Record<string, number> = {};
  const lower = headers.map(h => h.toLowerCase().trim());
  for (const [target, aliases] of Object.entries(map)) {
    for (const alias of aliases) {
      const idx = lower.findIndex(h => h === alias || h.includes(alias));
      if (idx !== -1) { lookup[target] = idx; break; }
    }
  }
  return lookup;
}

/**
 * Tally exports start with several preamble rows (company name, address, date
 * range, etc.) before the real column header row.
 *
 * Strategy: scan the first 25 rows and find the first one that matches
 * ≥3 DISTINCT target columns from the COL_MAP for this FileKind.
 * Requiring 3 distinct targets prevents false positives on preamble rows
 * like "From Date / To Date" which only match 1 target (invoice_date).
 */
function findHeaderRowIndex(
  rows: string[][],
  map: Record<string, string[]>,
): number {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const cells = rows[i].map(c => c.toLowerCase().trim());
    let distinctTargets = 0;
    for (const aliases of Object.values(map)) {
      if (aliases.some(a => cells.some(c => c === a || c.includes(a)))) {
        distinctTargets++;
      }
    }
    if (distinctTargets >= 3) return i;
  }
  return 0; // fallback to first row
}

/** Skip blank rows and Tally's Total/Grand Total footer rows */
function isDataRow(row: string[]): boolean {
  if (row.every(c => !c.trim())) return false;
  const first = row[0]?.trim().toLowerCase() ?? '';
  return !/^(total|grand total|sub.?total)/.test(first);
}

/**
 * Safety net: even after correct header detection Tally sometimes repeats
 * the header row mid-file. Skip any row whose date-column value is itself
 * a known column-name alias (i.e. it's a header, not a date).
 */
function isRepeatedHeader(
  row: string[],
  dateColIdx: number | undefined,
  dateAliases: string[],
): boolean {
  if (dateColIdx === undefined) return false;
  const val = row[dateColIdx]?.trim().toLowerCase() ?? '';
  return dateAliases.some(a => val === a || val.includes(a));
}

// ─── Row transformers ─────────────────────────────────────────────────────────

function transformSalesRow(raw: string[], lu: Record<string, number>) {
  return {
    invoice_date:  parseDate(raw[lu.invoice_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()    || null,
    customer_name: raw[lu.customer_name]?.trim() || null,
    product_sku:   lu.product_sku  !== undefined ? (raw[lu.product_sku]?.trim()  || null) : null,
    quantity:      lu.quantity     !== undefined ? parseNum(raw[lu.quantity])     : null,
    unit_price:    lu.unit_price   !== undefined ? parseNum(raw[lu.unit_price])   : null,
    total_amount:  parseNum(raw[lu.total_amount]),
    // material_type deliberately omitted — column does not exist in the sales table
  };
}

function transformPurchaseRow(raw: string[], lu: Record<string, number>) {
  return {
    po_date:       parseDate(raw[lu.po_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()   || null,
    vendor_name:   raw[lu.vendor_name]?.trim()  || null,
    total_amount:  parseNum(raw[lu.total_amount]),
    ...(lu.material_type !== undefined && { material_type: raw[lu.material_type]?.trim().toUpperCase() || null }),
  };
}

function transformSalesItemRow(raw: string[], lu: Record<string, number>) {
  return {
    invoice_date:  parseDate(raw[lu.invoice_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()    || null,
    customer_name: raw[lu.customer_name]?.trim() || null,
    item_name:     raw[lu.item_name]?.trim()     || null,
    quantity:      lu.quantity    !== undefined ? parseNum(raw[lu.quantity])    : null,
    unit:          lu.unit        !== undefined ? (raw[lu.unit]?.trim() || null) : null,
    base_amount:   lu.base_amount !== undefined ? parseNum(raw[lu.base_amount]) : null,
    gst_amount:    lu.gst_amount  !== undefined ? parseNum(raw[lu.gst_amount])  : null,
    total_amount:  parseNum(raw[lu.total_amount]),
    ...(lu.material_type !== undefined && { material_type: raw[lu.material_type]?.trim().toUpperCase() || null }),
  };
}

function transformPurchaseItemRow(raw: string[], lu: Record<string, number>) {
  return {
    invoice_date:  parseDate(raw[lu.invoice_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()    || null,
    supplier_name: raw[lu.supplier_name]?.trim() || null,
    item_name:     raw[lu.item_name]?.trim()     || null,
    quantity:      lu.quantity    !== undefined ? parseNum(raw[lu.quantity])    : null,
    unit:          lu.unit        !== undefined ? (raw[lu.unit]?.trim() || null) : null,
    base_amount:   lu.base_amount !== undefined ? parseNum(raw[lu.base_amount]) : null,
    gst_amount:    lu.gst_amount  !== undefined ? parseNum(raw[lu.gst_amount])  : null,
    total_amount:  parseNum(raw[lu.total_amount]),
    ...(lu.material_type !== undefined && { material_type: raw[lu.material_type]?.trim().toUpperCase() || null }),
  };
}

// ─── Core ingest ──────────────────────────────────────────────────────────────

async function ingestFile(
  file: File,
  onProgress: (pct: number, done: number, total: number) => void,
): Promise<{ table: string; rowsInserted: number }> {
  const kind = detectFileKind(file.name);

  // Master files are not transaction data — skip with a clear message
  if (kind === 'customer_master') {
    throw new Error(
      'Customer Master files contain contact details, not transactions. ' +
      'These are managed separately and cannot be imported here.',
    );
  }
  if (kind === 'supplier_master') {
    throw new Error(
      'Supplier Master files contain contact details, not transactions. ' +
      'These are managed separately and cannot be imported here.',
    );
  }
  if (kind === 'unknown') {
    throw new Error(
      `Cannot detect file type from "${file.name}". ` +
      'Rename it to include "Sales", "Purchase", "Item wise Sales", or "Item wise Purchase".',
    );
  }

  const table    = TABLE_MAP[kind];
  const colMap   = COL_MAP[kind];
  const text     = await file.text();

  // 1. Parse without headers to get raw rows
  const rawRows = (Papa.parse<string[]>(text, {
    header:         false,
    skipEmptyLines: true,
  }).data) as string[][];

  // 2. Find the real header row (requires ≥3 distinct target columns)
  const headerIdx = findHeaderRowIndex(rawRows, colMap);
  const headerRow = rawRows[headerIdx];
  const lu        = buildColLookup(headerRow, colMap);

  // 3. Build the date-alias list for repeated-header detection
  const dateKey      = kind === 'purchases' ? 'po_date' : 'invoice_date';
  const dateAliases  = colMap[dateKey] ?? [];
  const dateColIdx   = lu[dateKey];

  // 4. Slice data rows, filter blanks/totals/repeated-headers
  const dataRows = rawRows
    .slice(headerIdx + 1)
    .filter(row => isDataRow(row) && !isRepeatedHeader(row, dateColIdx, dateAliases));

  if (dataRows.length === 0) {
    throw new Error(`No data rows found after the header in "${file.name}".`);
  }

  // 5. Validate required columns are mapped
  const required: Record<string, string[]> = {
    sales:          ['invoice_date', 'total_amount'],
    purchases:      ['po_date', 'total_amount'],
    sales_items:    ['invoice_date', 'total_amount'],
    purchase_items: ['invoice_date', 'total_amount'],
  };
  for (const col of required[kind] ?? []) {
    if (lu[col] === undefined) {
      throw new Error(
        `Required column "${col}" not found in "${file.name}". ` +
        `Detected headers: ${headerRow.filter(Boolean).join(', ')}`,
      );
    }
  }

  // 6. Batch insert
  const total = dataRows.length;
  let inserted = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = dataRows.slice(i, i + BATCH_SIZE);
    const rows  = batch.map(raw => {
      switch (kind) {
        case 'sales':          return transformSalesRow(raw, lu);
        case 'purchases':      return transformPurchaseRow(raw, lu);
        case 'sales_items':    return transformSalesItemRow(raw, lu);
        case 'purchase_items': return transformPurchaseItemRow(raw, lu);
      }
    });

    const { error } = await supabase.from(table).insert(rows);
    if (error) {
      throw new Error(
        `Supabase error on rows ${i}–${i + batch.length}: ${error.message}`,
      );
    }

    inserted += batch.length;
    onProgress(Math.round((inserted / total) * 100), inserted, total);
  }

  return { table, rowsInserted: inserted };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  if (bytes < 1024)         return `${bytes} B`;
  if (bytes < 1024 * 1024)  return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_META: Record<
  UploadStatus,
  { label: string; color: string; Icon: React.FC<{ className?: string }> }
> = {
  idle:      { label: 'Queued',    color: 'text-zinc-400',    Icon: ({ className }) => <FileText     className={className} /> },
  parsing:   { label: 'Parsing',   color: 'text-blue-400',    Icon: ({ className }) => <Loader2      className={`${className} animate-spin`} /> },
  inserting: { label: 'Inserting', color: 'text-amber-400',   Icon: ({ className }) => <Database     className={className} /> },
  complete:  { label: 'Complete',  color: 'text-emerald-400', Icon: ({ className }) => <CheckCircle2 className={className} /> },
  error:     { label: 'Error',     color: 'text-red-400',     Icon: ({ className }) => <XCircle      className={className} /> },
};

function JobRow({ job }: { job: UploadJob }) {
  const { label, color, Icon } = STATUS_META[job.status];
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className={`h-4 w-4 shrink-0 ${color}`} />
          <span className="truncate text-sm text-white/90 font-medium">{job.filename}</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {job.table && (
            <span className="hidden sm:inline text-xs text-zinc-400 font-mono">→ {job.table}</span>
          )}
          <span className={`text-xs font-medium ${color}`}>{label}</span>
          <span className="text-xs text-zinc-500">{fmt(job.file_size)}</span>
        </div>
      </div>

      {(job.status === 'parsing' || job.status === 'inserting') && (
        <div className="mt-1">
          <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-400 transition-all duration-300"
              style={{ width: `${job.progress}%` }}
            />
          </div>
          {job.rows_total !== undefined && (
            <p className="mt-1 text-xs text-zinc-500">
              {job.rows_done?.toLocaleString()} / {job.rows_total.toLocaleString()} rows
            </p>
          )}
        </div>
      )}

      {job.status === 'complete' && job.rows_done !== undefined && (
        <p className="text-xs text-zinc-400">
          {job.rows_done.toLocaleString()} rows inserted into{' '}
          <span className="font-mono">{job.table}</span>
        </p>
      )}

      {job.status === 'error' && job.error && (
        <p className="text-xs text-red-400 break-words">{job.error}</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 10); }

export default function DataIngestion() {
  const [jobs, setJobs]       = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const push        = useNotificationStore((s) => s.push);
  const queryClient = useQueryClient();

  const updateJob = useCallback((id: string, patch: Partial<UploadJob>) => {
    setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    const csvFiles = files.filter(f => f.name.endsWith('.csv') || f.type === 'text/csv');
    if (csvFiles.length === 0) {
      push({ type: 'warning', title: 'No CSV files', message: 'Only .csv files are supported.' });
      return;
    }

    const oversized = csvFiles.filter(f => f.size > PARSE_LIMIT_BYTES);
    if (oversized.length > 0) {
      push({
        type:    'warning',
        title:   `File over ${PARSE_LIMIT_MB} MB`,
        message: `Cannot process in browser: ${oversized.map(f => f.name).join(', ')}`,
      });
    }

    const eligible = csvFiles.filter(f => f.size <= PARSE_LIMIT_BYTES);
    if (eligible.length === 0) return;

    const newJobs: UploadJob[] = eligible.map(f => ({
      id:         uid(),
      filename:   f.name,
      file_size:  f.size,
      status:     'idle' as UploadStatus,
      progress:   0,
      started_at: new Date().toISOString(),
    }));
    setJobs(prev => [...newJobs, ...prev]);

    for (const [i, file] of eligible.entries()) {
      const job = newJobs[i];

      try {
        updateJob(job.id, { status: 'parsing', progress: 0 });

        const { table, rowsInserted } = await ingestFile(
          file,
          (pct, done, total) => {
            updateJob(job.id, {
              status:     'inserting',
              progress:   pct,
              rows_done:  done,
              rows_total: total,
              table,
            });
          },
        );

        updateJob(job.id, {
          status:       'complete',
          progress:     100,
          rows_done:    rowsInserted,
          table,
          completed_at: new Date().toISOString(),
        });

        push({
          type:    'success',
          title:   'Ingestion complete',
          message: `${file.name} → ${rowsInserted.toLocaleString()} rows into "${table}". Dashboard refreshing…`,
        });

        queryClient.invalidateQueries({ queryKey: ['analytics-summary'] });
        queryClient.invalidateQueries({ queryKey: ['sales-purchase-table'] });

      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        updateJob(job.id, { status: 'error', error: message });
        push({ type: 'error', title: `Failed: ${file.name}`, message });
      }
    }
  }, [updateJob, push, queryClient]);

  const onDrop     = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);
  const onDragOver  = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Data Ingestion</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Drop CSV exports from Tally / Busy. Parsed in the browser and inserted
          directly into Supabase. Max {PARSE_LIMIT_MB} MB per file.
        </p>
      </div>

      {/* Drop zone */}
      <label
        htmlFor="csv-upload"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 transition-colors ${
          dragging
            ? 'border-amber-400 bg-amber-400/10'
            : 'border-white/20 bg-white/5 hover:border-white/40 hover:bg-white/10'
        }`}
      >
        <UploadCloud className={`h-10 w-10 ${dragging ? 'text-amber-400' : 'text-zinc-400'}`} />
        <p className="text-sm text-zinc-300">
          <span className="font-semibold text-white">Click to browse</span> or drag &amp; drop CSV files
        </p>
        <input
          id="csv-upload"
          type="file"
          accept=".csv,text/csv"
          multiple
          className="sr-only"
          onChange={onFileInput}
        />
      </label>

      {/* Schema reference */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Supported files → Supabase table
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {([
            { file: 'Sales.csv',             table: 'sales',          desc: 'Invoice-level sales' },
            { file: 'Purchase.csv',           table: 'purchases',      desc: 'Invoice-level purchases' },
            { file: 'Item wise Sales.csv',    table: 'sales_items',    desc: 'Line-item sales detail' },
            { file: 'Item wise Purchase.csv', table: 'purchase_items', desc: 'Line-item purchase detail' },
          ] as const).map(({ file, table, desc }) => (
            <div key={table} className="flex items-start gap-2 text-xs">
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span>
                <span className="font-mono text-white">{file}</span>
                <span className="text-zinc-400"> → </span>
                <span className="font-mono text-emerald-400">{table}</span>
                <span className="text-zinc-500"> — {desc}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-md bg-blue-500/10 px-3 py-2">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-400" />
          <p className="text-xs text-blue-200">
            Customer Master and Supplier Master files are not transaction data and
            will be skipped with a message — only upload the four file types above.
          </p>
        </div>
        <div className="mt-2 flex items-start gap-2 rounded-md bg-amber-400/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-200">
            Re-uploading the same file will insert duplicate rows. Clear the relevant
            Supabase table before re-ingesting the same period.
          </p>
        </div>
      </div>

      {/* Job list */}
      {jobs.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            Jobs — {jobs.length}
          </p>
          {jobs.map(j => <JobRow key={j.id} job={j} />)}
        </div>
      )}
    </div>
  );
}

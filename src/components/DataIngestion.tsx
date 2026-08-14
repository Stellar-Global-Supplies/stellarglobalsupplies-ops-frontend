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
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useNotificationStore } from '../store';
import type { UploadJob, UploadStatus } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PARSE_LIMIT_MB = 25;
const PARSE_LIMIT_BYTES = PARSE_LIMIT_MB * 1024 * 1024;
const BATCH_SIZE = 500; // rows per Supabase insert call

// ─── File-type detection ──────────────────────────────────────────────────────

type FileKind =
  | 'sales_items'
  | 'purchase_items'
  | 'sales'
  | 'purchase_orders'
  | 'unknown';

function detectFileKind(filename: string): FileKind {
  const n = filename.toLowerCase().replace(/[_\-\s]+/g, ' ');
  if (/item.*(wise|wise\s)?\s*purchase|purchase.*item/i.test(n)) return 'purchase_items';
  if (/item.*(wise|wise\s)?\s*sales?|sales?.*item/i.test(n))     return 'sales_items';
  if (/purchase|po\b|supplier/i.test(n))                          return 'purchase_orders';
  if (/sales?|invoice|customer/i.test(n))                         return 'sales';
  return 'unknown';
}

// ─── Column mappers ────────────────────────────────────────────────────────────
// Each entry: target_column → list of source header aliases (lowercase, trimmed)

const COL_MAP: Record<FileKind, Record<string, string[]>> = {
  sales: {
    invoice_date:  ['date', 'invoice date', 'vch date', 'voucher date', 'invoice_date', 'txn date'],
    invoice_no:    ['invoice no', 'voucher no', 'vch no', 'invoice number', 'invoice_no', 'vch no.', 'invoice no.'],
    customer_name: ['party name', 'customer name', 'customer_name', 'party', 'buyer name', 'buyer'],
    product_sku:   ['sku', 'item name', 'item', 'product name', 'product', 'goods', 'item_name', 'product_sku'],
    quantity:      ['qty', 'quantity', 'units', 'qty.'],
    unit_price:    ['rate', 'unit price', 'price', 'unit_price', 'rate per unit', 'price per unit'],
    total_amount:  ['net amount', 'total amount', 'amount', 'net amt', 'value', 'total', 'total_amount', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  purchase_orders: {
    po_date:       ['date', 'invoice date', 'vch date', 'voucher date', 'po date', 'po_date', 'txn date'],
    invoice_no:    ['invoice no', 'voucher no', 'vch no', 'invoice number', 'invoice_no', 'vch no.', 'po no', 'po number'],
    vendor_name:   ['party name', 'vendor name', 'supplier name', 'vendor_name', 'supplier_name', 'party', 'vendor', 'supplier'],
    total_amount:  ['net amount', 'total amount', 'amount', 'net amt', 'value', 'total', 'total_amount', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  sales_items: {
    invoice_date:  ['date', 'invoice date', 'vch date', 'voucher date', 'invoice_date', 'txn date'],
    invoice_no:    ['invoice no', 'voucher no', 'vch no', 'invoice number', 'invoice_no', 'vch no.'],
    customer_name: ['party name', 'customer name', 'customer_name', 'party', 'buyer name', 'buyer'],
    item_name:     ['item name', 'item', 'product name', 'goods', 'description', 'item_name'],
    quantity:      ['qty', 'quantity', 'units', 'qty.'],
    unit:          ['unit', 'uom', 'unit of measure', 'unit_of_measure'],
    base_amount:   ['base amount', 'taxable amount', 'taxable amt', 'amount ex gst', 'base_amount', 'basic amount', 'taxable value'],
    gst_amount:    ['gst amount', 'tax amount', 'gst', 'total tax', 'gst_amount', 'cgst + sgst', 'tax'],
    total_amount:  ['total amount', 'net amount', 'total', 'net total', 'total_amount', 'total value', 'value', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  purchase_items: {
    invoice_date:  ['date', 'invoice date', 'vch date', 'voucher date', 'invoice_date', 'txn date'],
    invoice_no:    ['invoice no', 'voucher no', 'vch no', 'invoice number', 'invoice_no', 'vch no.', 'po no'],
    supplier_name: ['party name', 'supplier name', 'vendor name', 'supplier_name', 'vendor_name', 'party', 'supplier', 'vendor'],
    item_name:     ['item name', 'item', 'product name', 'goods', 'description', 'item_name'],
    quantity:      ['qty', 'quantity', 'units', 'qty.'],
    unit:          ['unit', 'uom', 'unit of measure'],
    base_amount:   ['base amount', 'taxable amount', 'taxable amt', 'amount ex gst', 'base_amount', 'basic amount', 'taxable value'],
    gst_amount:    ['gst amount', 'tax amount', 'gst', 'total tax', 'gst_amount', 'tax'],
    total_amount:  ['total amount', 'net amount', 'total', 'net total', 'total_amount', 'total value', 'value', 'net value'],
    material_type: ['material type', 'material', 'grade', 'category', 'type', 'material_type'],
  },
  unknown: {},
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Parse Indian/international number strings: "1,25,000.50" → 125000.50 */
function parseNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const cleaned = String(v).replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/** Normalise a date string to ISO YYYY-MM-DD. Handles DD-MM-YYYY, DD/MM/YYYY, MM/DD/YYYY, etc. */
function parseDate(v: unknown): string {
  if (!v) return '';
  const s = String(v).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD-MM-YYYY or DD/MM/YYYY (common in Indian accounting exports)
  const dmy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (dmy) {
    const day   = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    const year  = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    // Assume DD/MM/YYYY for Indian software; if month > 12 it must be MM/DD
    if (parseInt(dmy[2]) > 12) {
      return `${year}-${day}-${month}`;
    }
    return `${year}-${month}-${day}`;
  }
  // Fallback: let Date parse it
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

/** Build a header→sourceKey lookup from the raw parsed header row */
function buildColLookup(
  headers: string[],
  map: Record<string, string[]>
): Record<string, number> {
  const lookup: Record<string, number> = {};
  const lowerHeaders = headers.map(h => h.toLowerCase().trim());
  for (const [target, aliases] of Object.entries(map)) {
    for (const alias of aliases) {
      const idx = lowerHeaders.findIndex(h => h === alias || h.includes(alias));
      if (idx !== -1) {
        lookup[target] = idx;
        break;
      }
    }
  }
  return lookup;
}

/**
 * Tally/Busy exports often have 3–10 rows of company name / report title
 * before the actual header row. Find the first row where ≥2 expected column
 * aliases appear and treat that as the header.
 */
function findHeaderRowIndex(rows: string[][], allAliases: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = rows[i].map(c => c.toLowerCase().trim());
    const hits  = allAliases.filter(a => cells.some(c => c === a || c.includes(a)));
    if (hits.length >= 2) return i;
  }
  return 0;
}

/** Skip blank rows and Tally's "Total" / "Grand Total" footer rows */
function isDataRow(row: string[]): boolean {
  if (row.every(c => c.trim() === '')) return false;
  const first = row[0]?.trim().toLowerCase() ?? '';
  if (/^(total|grand total|sub.?total|subtotal)/.test(first)) return false;
  return true;
}

// ─── CSV → Supabase row transformers ─────────────────────────────────────────

function transformSalesRow(raw: string[], lu: Record<string, number>) {
  return {
    invoice_date:  parseDate(raw[lu.invoice_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()   || null,
    customer_name: raw[lu.customer_name]?.trim() || null,
    product_sku:   raw[lu.product_sku]?.trim()   || null,
    quantity:      lu.quantity    !== undefined ? parseNum(raw[lu.quantity])    : null,
    unit_price:    lu.unit_price  !== undefined ? parseNum(raw[lu.unit_price])  : null,
    total_amount:  parseNum(raw[lu.total_amount]),
    material_type: raw[lu.material_type]?.trim().toUpperCase() || null,
  };
}

function transformPurchaseRow(raw: string[], lu: Record<string, number>) {
  return {
    po_date:       parseDate(raw[lu.po_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()   || null,
    vendor_name:   raw[lu.vendor_name]?.trim()  || null,
    total_amount:  parseNum(raw[lu.total_amount]),
    material_type: raw[lu.material_type]?.trim().toUpperCase() || null,
  };
}

function transformSalesItemRow(raw: string[], lu: Record<string, number>) {
  return {
    invoice_date:  parseDate(raw[lu.invoice_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()    || null,
    customer_name: raw[lu.customer_name]?.trim() || null,
    item_name:     raw[lu.item_name]?.trim()     || null,
    quantity:      lu.quantity     !== undefined ? parseNum(raw[lu.quantity])     : null,
    unit:          raw[lu.unit]?.trim()          || null,
    base_amount:   lu.base_amount  !== undefined ? parseNum(raw[lu.base_amount])  : null,
    gst_amount:    lu.gst_amount   !== undefined ? parseNum(raw[lu.gst_amount])   : null,
    total_amount:  parseNum(raw[lu.total_amount]),
    material_type: raw[lu.material_type]?.trim().toUpperCase() || null,
  };
}

function transformPurchaseItemRow(raw: string[], lu: Record<string, number>) {
  return {
    invoice_date:  parseDate(raw[lu.invoice_date]),
    invoice_no:    raw[lu.invoice_no]?.trim()    || null,
    supplier_name: raw[lu.supplier_name]?.trim() || null,
    item_name:     raw[lu.item_name]?.trim()     || null,
    quantity:      lu.quantity    !== undefined ? parseNum(raw[lu.quantity])     : null,
    unit:          raw[lu.unit]?.trim()          || null,
    base_amount:   lu.base_amount !== undefined ? parseNum(raw[lu.base_amount])  : null,
    gst_amount:    lu.gst_amount  !== undefined ? parseNum(raw[lu.gst_amount])   : null,
    total_amount:  parseNum(raw[lu.total_amount]),
    material_type: raw[lu.material_type]?.trim().toUpperCase() || null,
  };
}

// ─── Core ingest function ─────────────────────────────────────────────────────

async function ingestFile(
  file: File,
  onProgress: (pct: number, done: number, total: number) => void
): Promise<{ table: string; rowsInserted: number }> {
  const kind = detectFileKind(file.name);
  if (kind === 'unknown') {
    throw new Error(
      `Cannot detect file type from "${file.name}". ` +
      'Rename it to include "Sales", "Purchase", "Item wise Sales", or "Item wise Purchase".'
    );
  }

  const table = kind; // table name matches FileKind value

  // 1. Read the whole file as text (≤25 MB so this is safe)
  const text = await file.text();

  // 2. Parse without headers first to find the actual header row
  const rawResult = Papa.parse<string[]>(text, {
    header:     false,
    skipEmptyLines: true,
  });
  const rawRows = rawResult.data as string[][];

  const colMap    = COL_MAP[kind];
  const allAliases = Object.values(colMap).flat();
  const headerIdx  = findHeaderRowIndex(rawRows, allAliases);
  const headerRow  = rawRows[headerIdx] as string[];
  const lu         = buildColLookup(headerRow, colMap);

  const dataRows = rawRows.slice(headerIdx + 1).filter(isDataRow);
  const total    = dataRows.length;

  if (total === 0) throw new Error('No data rows found after the header row.');

  // Required columns check
  const required: Record<FileKind, string[]> = {
    sales:           ['invoice_date', 'total_amount'],
    purchase_orders: ['po_date', 'total_amount'],
    sales_items:     ['invoice_date', 'total_amount'],
    purchase_items:  ['invoice_date', 'total_amount'],
    unknown:         [],
  };
  for (const col of required[kind]) {
    if (lu[col] === undefined) {
      throw new Error(
        `Required column "${col}" not found in "${file.name}". ` +
        `Headers detected: ${headerRow.join(', ')}`
      );
    }
  }

  // 3. Batch insert into Supabase
  let inserted = 0;
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = dataRows.slice(i, i + BATCH_SIZE);

    const rows = batch.map(raw => {
      switch (kind) {
        case 'sales':           return transformSalesRow(raw, lu);
        case 'purchase_orders': return transformPurchaseRow(raw, lu);
        case 'sales_items':     return transformSalesItemRow(raw, lu);
        case 'purchase_items':  return transformPurchaseItemRow(raw, lu);
      }
    });

    const { error } = await supabase.from(table).insert(rows);
    if (error) {
      throw new Error(`Supabase error on rows ${i}–${i + batch.length}: ${error.message}`);
    }

    inserted += batch.length;
    onProgress(Math.round((inserted / total) * 100), inserted, total);
  }

  return { table, rowsInserted: inserted };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_META: Record<UploadStatus, { label: string; color: string; Icon: React.FC<{ className?: string }> }> = {
  idle:      { label: 'Queued',    color: 'text-zinc-400',   Icon: ({ className }) => <FileText    className={className} /> },
  parsing:   { label: 'Parsing',   color: 'text-blue-400',   Icon: ({ className }) => <Loader2     className={`${className} animate-spin`} /> },
  inserting: { label: 'Inserting', color: 'text-amber-400',  Icon: ({ className }) => <Database    className={className} /> },
  complete:  { label: 'Complete',  color: 'text-emerald-400',Icon: ({ className }) => <CheckCircle2 className={className} /> },
  error:     { label: 'Error',     color: 'text-red-400',    Icon: ({ className }) => <XCircle     className={className} /> },
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
          {job.rows_done.toLocaleString()} rows inserted into <span className="font-mono">{job.table}</span>
        </p>
      )}

      {job.status === 'error' && job.error && (
        <p className="text-xs text-red-400 break-words">{job.error}</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function DataIngestion() {
  const [jobs, setJobs]   = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const push        = useNotificationStore((s) => s.push);
  const queryClient = useQueryClient();

  const updateJob = useCallback((id: string, patch: Partial<UploadJob>) => {
    setJobs(prev => prev.map(j => j.id === id ? { ...j, ...patch } : j));
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
        title:   'File too large',
        message: `Files over ${PARSE_LIMIT_MB} MB cannot be processed in the browser: ${oversized.map(f => f.name).join(', ')}`,
      });
    }

    const eligible = csvFiles.filter(f => f.size <= PARSE_LIMIT_BYTES);
    if (eligible.length === 0) return;

    // Create job entries immediately so UI updates
    const newJobs: UploadJob[] = eligible.map(f => ({
      id:         uid(),
      filename:   f.name,
      file_size:  f.size,
      status:     'idle',
      progress:   0,
      started_at: new Date().toISOString(),
    }));
    setJobs(prev => [...newJobs, ...prev]);

    // Process sequentially to avoid hammering Supabase
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
          }
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
          message: `${file.name} → ${rowsInserted.toLocaleString()} rows inserted into "${table}". Dashboard refreshing…`,
        });

        // Invalidate all dashboard queries so they refetch fresh data
        queryClient.invalidateQueries({ queryKey: ['analytics-summary'] });
        queryClient.invalidateQueries({ queryKey: ['sales-purchase-table'] });

      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        updateJob(job.id, { status: 'error', error: message });
        push({ type: 'error', title: `Failed: ${file.name}`, message });
      }
    }
  }, [updateJob, push, queryClient]);

  // ── Drag-and-drop handlers ──
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    processFiles(Array.from(e.dataTransfer.files));
  }, [processFiles]);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const inputId = 'csv-upload-input';

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Data Ingestion</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Drop CSV exports from Tally / Busy. Rows are parsed in the browser
          and inserted directly into Supabase — no S3 required.
          Max {PARSE_LIMIT_MB} MB per file.
        </p>
      </div>

      {/* Drop zone */}
      <label
        htmlFor={inputId}
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
          id={inputId}
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
          Expected file names → Supabase table
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[
            { file: 'Sales.csv',               table: 'sales',           desc: 'Invoice-level sales' },
            { file: 'Purchase.csv',             table: 'purchase_orders', desc: 'Invoice-level purchases' },
            { file: 'Item wise Sales.csv',      table: 'sales_items',     desc: 'Line-item sales detail' },
            { file: 'Item wise Purchase.csv',   table: 'purchase_items',  desc: 'Line-item purchase detail' },
          ].map(({ file, table, desc }) => (
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
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-400/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-200">
            Re-uploading the same file will insert duplicate rows. Clear existing data
            from Supabase before re-ingesting the same period.
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
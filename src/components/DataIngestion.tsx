/**
 * DataIngestion.tsx
 *
 * Browser-side port of the SGS Lambda ingest parser.
 *
 * Tally exports have NO traditional column-header row. Instead every data row
 * begins with a sequential Sr. No. (a bare integer). All fields are read at
 * fixed offsets from that integer — exactly how the Lambda works.
 *
 * Flow: File drop → PapaParse (raw rows) → firstDataIndex per row → positional
 *       field extraction → Supabase upsert (same conflict columns as Lambda).
 */

import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Papa from 'papaparse';
import {
  UploadCloud, CheckCircle2, XCircle, Loader2,
  FileText, AlertTriangle, Database,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useNotificationStore } from '../store';
import type { UploadJob, UploadStatus } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const PARSE_LIMIT_MB    = 25;
const PARSE_LIMIT_BYTES = PARSE_LIMIT_MB * 1024 * 1024;
const BATCH_SIZE        = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

type SGSFileType =
  | 'sales_register'
  | 'purchase_register'
  | 'item_sales'
  | 'item_purchase'
  | 'customers'
  | 'suppliers';

type TableName =
  | 'sales'
  | 'purchases'
  | 'sales_items'
  | 'purchase_items'
  | 'customers'
  | 'suppliers';

interface ParsedRow {
  table: TableName;
  row:   Record<string, unknown>;
}

// Conflict columns for upsert — mirrors Lambda's conflictColumn()
const CONFLICT_COL: Record<TableName, string> = {
  customers:      'customer_name',
  suppliers:      'supplier_name',
  sales:          'invoice_no',
  purchases:      'invoice_no',
  sales_items:    'row_key',
  purchase_items: 'row_key',
};

// ─── File-type detection (mirrors Lambda detectFileType) ──────────────────────

function detectFileType(filename: string): SGSFileType | null {
  const k = filename.toLowerCase();
  // Master files first — "Customers july.csv" must not fall into sales
  if (k.includes('customer'))                                    return 'customers';
  if (k.includes('supplier'))                                    return 'suppliers';
  // Item-wise before plain register
  if (k.includes('item') && k.includes('sale'))                 return 'item_sales';
  if (k.includes('item') && (k.includes('purchase') || k.includes('purch'))) return 'item_purchase';
  // Invoice-level registers
  if (k.includes('purchase') || k.includes('purch'))            return 'purchase_register';
  if (k.includes('sale'))                                        return 'sales_register';
  return null;
}

// ─── Helpers (direct port of Lambda utilities) ────────────────────────────────

/** Collapse embedded newlines in quoted Tally fields into a single space */
function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(p => p.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Take only the first line of a multi-line Tally field (e.g. customer address blocks) */
function firstLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(p => p.trim())
    .find(Boolean) ?? '';
}

/** Strip Indian comma formatting and parse to float: "1,25,000.50" → 125000.5 */
function cleanAmount(value: unknown): number {
  const n = parseFloat(
    String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, ''),
  );
  return isFinite(n) ? n : 0;
}

/** Parse DD/MM/YYYY (Tally default) or YYYY-MM-DD to ISO date string */
function parseDate(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

/** Split "100 KGS" → { quantity: 100, unit: "KGS" } */
function parseQuantity(value: unknown): { quantity: number; unit: string } {
  const raw   = cleanText(value);
  const match = raw.match(/(-?[\d,.]+)\s*(.*)$/);
  if (!match) return { quantity: 0, unit: '' };
  return { quantity: cleanAmount(match[1]), unit: match[2].trim().toUpperCase() };
}

/** Derive material type from item name — no CSV column needed */
function materialType(itemName: unknown): string {
  const name = cleanText(itemName).toUpperCase();
  if (name.startsWith('SS') || name.includes(' STAINLESS')) return 'SS';
  if (name.startsWith('MS') || name.includes(' MILD STEEL')) return 'MS';
  if (name.includes('FREIGHT') || name.includes('LOADING'))  return 'SERVICE';
  return 'OTHER';
}

/** SHA-256 row key for item deduplication (browser Web Crypto API) */
async function computeRowKey(parts: unknown[]): Promise<string> {
  const text = parts.map(p => cleanText(String(p))).join('|');
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Finds the first column index that is a pure integer — the Tally Sr. No.
 * Preamble rows (company name, date range, header labels) never start with
 * a bare number, so they naturally return -1 and are skipped.
 */
function firstDataIndex(record: string[]): number {
  return record.findIndex(v => /^\d+$/.test(cleanText(v)));
}

// ─── Row parsers (direct port of Lambda parse* functions) ────────────────────

function parseMaster(
  record: string[],
  sourceFile: string,
  type: 'customers' | 'suppliers',
): ParsedRow | null {
  const idx = firstDataIndex(record);
  if (idx < 0) return null;

  const name = firstLine(record[idx + 1]);
  if (!name || /^(customer details|supplier details)$/i.test(name)) return null;

  const gstPattern = /\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]/;
  const gst = record.map(cleanText).find(v => gstPattern.test(v));
  const nameCol = type === 'customers' ? 'customer_name' : 'supplier_name';

  return {
    table: type,
    row:   { [nameCol]: name, gstin: gst ?? null, source_file: sourceFile },
  };
}

function parseSalesRegister(record: string[], sourceFile: string): ParsedRow | null {
  const idx = firstDataIndex(record);
  if (idx < 0) return null;

  const invoiceNo    = cleanText(record[idx + 1]);
  const invoiceDate  = parseDate(record[idx + 2]);
  const customerName = cleanText(record[idx + 3]);
  const amount       = cleanAmount(record[idx + 5]);

  if (!invoiceNo || !invoiceDate || !customerName || amount <= 0) return null;

  return {
    table: 'sales',
    row: {
      invoice_no:    invoiceNo,
      invoice_date:  invoiceDate,
      customer_name: customerName,
      invoice_type:  cleanText(record[idx + 4]) || null,
      total_amount:  amount,
      source_file:   sourceFile,
    },
  };
}

function parsePurchaseRegister(record: string[], sourceFile: string): ParsedRow | null {
  const idx = firstDataIndex(record);
  if (idx < 0) return null;

  // Purchase register has an extra internal Tally ID before the invoice number
  const invoiceId    = cleanText(record[idx + 1]);
  const invoiceNo    = cleanText(record[idx + 2]);
  const invoiceDate  = parseDate(record[idx + 3]);
  const supplierName = cleanText(record[idx + 4]);
  const amount       = cleanAmount(record[idx + 6]);

  if (!invoiceNo || !invoiceDate || !supplierName || amount <= 0) return null;

  return {
    table: 'purchases',
    row: {
      invoice_no:    invoiceNo,
      invoice_date:  invoiceDate,
      supplier_name: supplierName,
      invoice_id:    invoiceId || null,
      invoice_type:  cleanText(record[idx + 5]) || null,
      total_amount:  amount,
      source_file:   sourceFile,
    },
  };
}

async function parseSalesItem(record: string[], sourceFile: string): Promise<ParsedRow | null> {
  const idx = firstDataIndex(record);
  if (idx < 0) return null;

  const invoiceNo    = cleanText(record[idx + 1]);
  const invoiceDate  = parseDate(record[idx + 2]);
  const customerName = cleanText(record[idx + 3]);
  const itemName     = cleanText(record[idx + 4]);
  const qty          = parseQuantity(record[idx + 5]);
  const baseAmount   = cleanAmount(record[idx + 6]);
  const gstRate      = cleanAmount(record[idx + 7]);
  const gstAmount    = cleanAmount(record[idx + 8]);
  const totalAmount  = cleanAmount(record[idx + 9]);

  if (!invoiceNo || !invoiceDate || !itemName || totalAmount <= 0) return null;

  const key = await computeRowKey([
    sourceFile, invoiceNo, invoiceDate, customerName, itemName, record[idx], totalAmount,
  ]);

  return {
    table: 'sales_items',
    row: {
      row_key:       key,
      invoice_no:    invoiceNo,
      invoice_date:  invoiceDate,
      customer_name: customerName,
      item_name:     itemName,
      quantity:      qty.quantity,
      unit:          qty.unit,
      material_type: materialType(itemName),
      base_amount:   baseAmount,
      gst_rate:      gstRate,
      gst_amount:    gstAmount,
      total_amount:  totalAmount,
      source_file:   sourceFile,
      created_at:    new Date().toISOString(),
    },
  };
}

async function parsePurchaseItem(record: string[], sourceFile: string): Promise<ParsedRow | null> {
  const idx = firstDataIndex(record);
  if (idx < 0) return null;

  const invoiceNo    = cleanText(record[idx + 1]);
  const invoiceDate  = parseDate(record[idx + 2]);
  const supplierName = cleanText(record[idx + 3]);
  const itemName     = cleanText(record[idx + 4]);
  const qty          = parseQuantity(record[idx + 5]);
  const baseAmount   = cleanAmount(record[idx + 6]);
  const gstRate      = cleanAmount(record[idx + 7]);
  const gstAmount    = cleanAmount(record[idx + 8]);
  const totalAmount  = cleanAmount(record[idx + 9]);

  if (!invoiceNo || !invoiceDate || !itemName || totalAmount <= 0) return null;

  const key = await computeRowKey([
    sourceFile, invoiceNo, invoiceDate, supplierName, itemName, record[idx], totalAmount,
  ]);

  return {
    table: 'purchase_items',
    row: {
      row_key:       key,
      invoice_no:    invoiceNo,
      invoice_date:  invoiceDate,
      supplier_name: supplierName,
      item_name:     itemName,
      quantity:      qty.quantity,
      unit:          qty.unit,
      material_type: materialType(itemName),
      base_amount:   baseAmount,
      gst_rate:      gstRate,
      gst_amount:    gstAmount,
      total_amount:  totalAmount,
      source_file:   sourceFile,
      created_at:    new Date().toISOString(),
    },
  };
}

async function parseRecord(
  record: string[],
  fileType: SGSFileType,
  sourceFile: string,
): Promise<ParsedRow | null> {
  switch (fileType) {
    case 'customers':         return parseMaster(record, sourceFile, 'customers');
    case 'suppliers':         return parseMaster(record, sourceFile, 'suppliers');
    case 'sales_register':    return parseSalesRegister(record, sourceFile);
    case 'purchase_register': return parsePurchaseRegister(record, sourceFile);
    case 'item_sales':        return parseSalesItem(record, sourceFile);
    case 'item_purchase':     return parsePurchaseItem(record, sourceFile);
  }
}

function groupByTable(records: ParsedRow[]): Map<TableName, Record<string, unknown>[]> {
  const map = new Map<TableName, Record<string, unknown>[]>();
  for (const { table, row } of records) {
    const rows = map.get(table) ?? [];
    rows.push(row);
    map.set(table, rows);
  }
  return map;
}

// ─── Core ingest ──────────────────────────────────────────────────────────────

async function ingestFile(
  file: File,
  onInserting: (pct: number, done: number, total: number, table: string) => void,
): Promise<{ tables: string[]; rowsInserted: number }> {
  const fileType = detectFileType(file.name);
  if (!fileType) {
    throw new Error(
      `Cannot detect file type from "${file.name}". ` +
      'Filename must include "Sales", "Purchase", "Item wise Sales", ' +
      '"Item wise Purchase", "Customers", or "Suppliers".',
    );
  }

  const sourceFile = file.name;
  const text       = await file.text();

  // PapaParse handles quoted fields with embedded newlines (Tally master files)
  const rawRows = (Papa.parse<string[]>(text, {
    header:         false,
    skipEmptyLines: true,
  }).data) as string[][];

  // Parse every row independently — no header row detection needed.
  // firstDataIndex returns -1 for preamble/header/total rows → they return null.
  const CHUNK = 500; // parse in chunks to avoid blocking the event loop
  const records: ParsedRow[] = [];
  for (let i = 0; i < rawRows.length; i += CHUNK) {
    const chunk = await Promise.all(
      rawRows.slice(i, i + CHUNK).map(row => parseRecord(row, fileType, sourceFile)),
    );
    records.push(...chunk.filter((r): r is ParsedRow => r !== null));
  }

  if (records.length === 0) {
    throw new Error(
      `No valid data rows found in "${file.name}". ` +
      'Confirm the file is a Tally export containing transaction data.',
    );
  }

  // Upsert in batches — same conflict columns as the Lambda.
  // Item tables use a raw PostgREST fetch with Prefer: resolution=ignore-duplicates
  // to emit ON CONFLICT DO NOTHING without going through the Supabase JS client
  // upsert path that triggers "DELETE requires a WHERE clause".
  const grouped      = groupByTable(records);
  const totalRows    = records.length;
  let   inserted     = 0;
  const tableNames: string[] = [];

  // Retrieve PostgREST URL + current user session token for RLS compliance
  const supabaseUrl = (supabase as any).supabaseUrl as string;
  const supabaseKey = (supabase as any).supabaseKey as string;
  const { data: { session } } = await supabase.auth.getSession();
  const authToken = session?.access_token ?? supabaseKey;

  for (const [table, rows] of grouped) {
    tableNames.push(table);
    const conflictCol = CONFLICT_COL[table];
    const isItemTable = table === 'sales_items' || table === 'purchase_items';

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);

      if (isItemTable) {
        // Raw PostgREST: POST with resolution=ignore-duplicates
        // True INSERT … ON CONFLICT (row_key) DO NOTHING — no DELETE involved
        const res = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'apikey':        supabaseKey,
            'Authorization': `Bearer ${authToken}`,
            'Prefer':        'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify(batch),
        });
        if (!res.ok) {
          const msg = await res.text();
          throw new Error(`${table}: ${msg}`);
        }
      } else {
        const { error } = await supabase
          .from(table)
          .upsert(batch, { onConflict: conflictCol });
        if (error) throw new Error(`${table}: ${error.message}`);
      }

      inserted += batch.length;
      onInserting(
        Math.round((inserted / totalRows) * 100),
        inserted,
        totalRows,
        tableNames.join(', '),
      );
    }
  }

  // Mirror the Lambda's ingestion_files audit log
  await supabase.from('ingestion_files').upsert(
    {
      source_file:   sourceFile,
      file_type:     fileType,
      row_count:     records.length,
      status:        'complete',
      error_message: null,
      ingested_at:   new Date().toISOString(),
    },
    { onConflict: 'source_file' },
  );

  return { tables: tableNames, rowsInserted: inserted };
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

function fmt(bytes: number) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_META: Record<
  UploadStatus,
  { label: string; color: string; Icon: React.FC<{ className?: string }> }
> = {
  idle:      { label: 'Queued',    color: 'text-zinc-400',    Icon: p => <FileText     {...p} /> },
  parsing:   { label: 'Parsing',   color: 'text-blue-400',    Icon: p => <Loader2      {...p} className={`${p.className} animate-spin`} /> },
  inserting: { label: 'Inserting', color: 'text-amber-400',   Icon: p => <Database     {...p} /> },
  complete:  { label: 'Complete',  color: 'text-emerald-400', Icon: p => <CheckCircle2 {...p} /> },
  error:     { label: 'Error',     color: 'text-red-400',     Icon: p => <XCircle      {...p} /> },
};

function JobRow({ job }: { job: UploadJob }) {
  const { label, color, Icon } = STATUS_META[job.status];
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={`h-4 w-4 shrink-0 ${color}`} />
          <span className="truncate text-sm font-medium text-white/90">{job.filename}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {job.table && (
            <span className="hidden font-mono text-xs text-zinc-400 sm:inline">→ {job.table}</span>
          )}
          <span className={`text-xs font-medium ${color}`}>{label}</span>
          <span className="text-xs text-zinc-500">{fmt(job.file_size)}</span>
        </div>
      </div>

      {(job.status === 'parsing' || job.status === 'inserting') && (
        <div className="mt-1">
          <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
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

      {job.status === 'complete' && (
        <p className="text-xs text-zinc-400">
          {job.rows_done?.toLocaleString()} rows upserted into{' '}
          <span className="font-mono">{job.table}</span>
        </p>
      )}

      {job.status === 'error' && job.error && (
        <p className="break-words text-xs text-red-400">{job.error}</p>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2, 10); }

export default function DataIngestion() {
  const [jobs, setJobs]         = useState<UploadJob[]>([]);
  const [dragging, setDragging] = useState(false);
  const push        = useNotificationStore(s => s.push);
  const queryClient = useQueryClient();

  const updateJob = useCallback((id: string, patch: Partial<UploadJob>) => {
    setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    const csvFiles = files.filter(f => f.name.endsWith('.csv') || f.type === 'text/csv');
    if (!csvFiles.length) {
      push({ type: 'warning', title: 'No CSV files', message: 'Only .csv files are supported.' });
      return;
    }

    const oversized = csvFiles.filter(f => f.size > PARSE_LIMIT_BYTES);
    if (oversized.length) {
      push({
        type: 'warning', title: `File over ${PARSE_LIMIT_MB} MB`,
        message: `Cannot process in browser: ${oversized.map(f => f.name).join(', ')}`,
      });
    }

    const eligible = csvFiles.filter(f => f.size <= PARSE_LIMIT_BYTES);
    if (!eligible.length) return;

    const newJobs: UploadJob[] = eligible.map(f => ({
      id: uid(), filename: f.name, file_size: f.size,
      status: 'idle' as UploadStatus, progress: 0,
      started_at: new Date().toISOString(),
    }));
    setJobs(prev => [...newJobs, ...prev]);

    for (const [i, file] of eligible.entries()) {
      const job = newJobs[i];
      try {
        updateJob(job.id, { status: 'parsing', progress: 0 });

        const { tables, rowsInserted } = await ingestFile(
          file,
          (pct, done, total, table) => updateJob(job.id, {
            status: 'inserting', progress: pct,
            rows_done: done, rows_total: total, table,
          }),
        );

        updateJob(job.id, {
          status: 'complete', progress: 100,
          rows_done: rowsInserted, table: tables.join(', '),
          completed_at: new Date().toISOString(),
        });

        push({
          type: 'success', title: 'Ingestion complete',
          message: `${file.name} → ${rowsInserted.toLocaleString()} rows into "${tables.join(', ')}". Dashboard refreshing…`,
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

  const onDrop      = useCallback((e: React.DragEvent) => {
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
          Drop Tally CSV exports. Parsed in the browser and upserted directly into
          Supabase — no S3 required. Max {PARSE_LIMIT_MB} MB per file.
        </p>
      </div>

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
        <input id="csv-upload" type="file" accept=".csv,text/csv" multiple className="sr-only" onChange={onFileInput} />
      </label>

      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Supported Tally exports → Supabase table
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {([
            { file: 'Sales Register.csv',          table: 'sales',          desc: 'Invoice-level sales' },
            { file: 'Purchase Register.csv',        table: 'purchases',      desc: 'Invoice-level purchases' },
            { file: 'Item wise Sales.csv',          table: 'sales_items',    desc: 'Line-item sales detail' },
            { file: 'Item wise Purchase.csv',       table: 'purchase_items', desc: 'Line-item purchase detail' },
            { file: 'Customers.csv',                table: 'customers',      desc: 'Customer master' },
            { file: 'Suppliers.csv',                table: 'suppliers',      desc: 'Supplier master' },
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
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-400/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-200">
            Re-uploads are safe — rows are upserted using the same conflict keys as the
            Lambda (invoice_no for registers, SHA-256 row_key for item files).
          </p>
        </div>
      </div>

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

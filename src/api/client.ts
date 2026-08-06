/**
 * SGS Ops API Client — Cloudflare Workers backend
 *
 * Active endpoints:
 *   POST /upload/presign     → S3 presigned URL
 *   POST /email/send         → Gmail bulk email
 *   GET  /analytics/meta     → Meta analytics (live + cached)
 *   POST /analytics/meta/refresh → bust cache
 *
 * Removed: agents, docs-drive, social-poster, savings-calculator, google-auth OAuth
 */

import type {
  AnalyticsSummary,
  PresignRequest,
  PresignResponse,
} from '@/types';
import { supabase } from '@/lib/supabase';

const BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? '';

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });

  if (!response.ok) {
    let body: unknown;
    try { body = await response.json(); } catch { /* ignore */ }
    throw new ApiError(response.status, `API ${init.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}`, body);
  }

  if (response.status === 204) return null as T;
  return response.json() as Promise<T>;
}

// ────────────────────────────────────────────────────────────────────────────
// Analytics (reads from Supabase directly)
// ────────────────────────────────────────────────────────────────────────────

import { fetchAnalyticsSummarySupabase } from '@/services/analytics';

export async function fetchAnalyticsSummary(months: number = 6): Promise<AnalyticsSummary> {
  return fetchAnalyticsSummarySupabase(months);
}

// ────────────────────────────────────────────────────────────────────────────
// S3 Presigned Upload
// ────────────────────────────────────────────────────────────────────────────

export async function requestPresignedUrl(payload: PresignRequest): Promise<PresignResponse> {
  return request<PresignResponse>('/upload/presign', { method: 'POST', body: JSON.stringify(payload) });
}

export async function uploadFileToS3(uploadUrl: string, file: File, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(xhr.status, `S3 upload failed: ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('S3 upload network error')));
    xhr.addEventListener('abort', () => reject(new Error('S3 upload aborted')));
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.send(file);
  });
}

export { ApiError };

// ────────────────────────────────────────────────────────────────────────────
// Bulk Email (Gmail via Worker — no OAuth flow needed, static token)
// ────────────────────────────────────────────────────────────────────────────

export interface EncodedAttachment {
  name: string;
  type: string;
  data: string;
}

export interface BulkEmailRequest {
  recipients:   string[];
  subject:      string;
  body:         string;
  attachments?: File[];
}

export interface BulkEmailResponse {
  total:    number;
  success:  number;
  failed:   number;
  errors?:  Array<{ email: string; error: string }>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function sendBulkEmail(payload: BulkEmailRequest): Promise<BulkEmailResponse> {
  const base = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user?.id) throw new Error('User not authenticated');

  let encodedAttachments: EncodedAttachment[] = [];
  if (payload.attachments && payload.attachments.length > 0) {
    encodedAttachments = await Promise.all(
      payload.attachments.map(async (file): Promise<EncodedAttachment> => ({
        name: file.name,
        type: file.type || 'application/octet-stream',
        data: await fileToBase64(file),
      })),
    );
  }

  const res = await fetch(`${base}/email/send`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipients:  payload.recipients,
      subject:     payload.subject,
      body:        payload.body,
      attachments: encodedAttachments,
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({})) as Record<string, string>;
    throw new Error(error?.error || error?.message || `HTTP ${res.status}`);
  }

  return res.json() as Promise<BulkEmailResponse>;
}

// ────────────────────────────────────────────────────────────────────────────
// Meta Analytics — live scrape via Worker (with KV cache)
// ────────────────────────────────────────────────────────────────────────────

import type { MetaAnalyticsData, AnalyticsPeriod } from '@/types';

export async function fetchMetaAnalytics(period: AnalyticsPeriod = 'weekly'): Promise<MetaAnalyticsData> {
  try {
    const data = await request<MetaAnalyticsData>(`/analytics/meta?period=${period}`);
    const hasNativeShape = Boolean((data as unknown as Record<string, unknown>)?.instagram || (data as unknown as Record<string, unknown>)?.facebook || (data as unknown as Record<string, unknown>)?.ads);
    if (!hasNativeShape) throw new Error('Meta analytics returned empty payload.');
    return data;
  } catch (err) {
    console.warn('[analytics] Falling back to bundled Meta analytics JSON', err);
    const fallback = await fetch(`/meta/${period}.json`, { cache: 'no-store' });
    if (!fallback.ok) throw err;
    return fallback.json() as Promise<MetaAnalyticsData>;
  }
}

export async function refreshMetaAnalytics(): Promise<{ success: boolean; message?: string }> {
  return request<{ success: boolean; message?: string }>('/analytics/meta/refresh', { method: 'POST' });
}
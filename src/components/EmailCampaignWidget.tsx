/**
 * EmailCampaignWidget
 * Simplified: no Google OAuth flow, no connection status check.
 * Gmail is always ready — credentials live in Worker secrets.
 */
import { useState, useCallback } from 'react';
import { Mail, Upload, Paperclip, Send, XCircle, Loader2, CheckCircle } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { sendBulkEmail } from '@/api/client';

type Recipient  = { email: string; name?: string; [key: string]: unknown };
type Attachment = { file: File; preview?: string };

export default function EmailCampaignWidget() {
  const [recipients,     setRecipients]     = useState<Recipient[]>([]);
  const [subject,        setSubject]        = useState('');
  const [emailBody,      setEmailBody]      = useState('');
  const [attachments,    setAttachments]    = useState<Attachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [successMsg,     setSuccessMsg]     = useState<string | null>(null);
  const [errorMsg,       setErrorMsg]       = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: sendBulkEmail,
    onSuccess: (data) => {
      const errNote = data.errors?.length
        ? `\n\nFailed: ${data.errors.map(e => `${e.email}: ${e.error}`).join(', ')}`
        : '';
      setSuccessMsg(`Sent ${data.success}/${data.total} emails successfully.${errNote}`);
      setErrorMsg(null);
      setRecipients([]);
      setSubject('');
      setEmailBody('');
      setAttachments([]);
    },
    onError: (e: Error) => {
      setErrorMsg(e.message ?? 'Unknown error');
      setSuccessMsg(null);
    },
  });

  const handleCsvUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadProgress('Reading CSV…');
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text    = ev.target?.result as string;
        const lines   = text.split('\n').filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const idx     = headers.findIndex(h => h.includes('email'));
        if (idx === -1) { setUploadProgress(null); setErrorMsg('No "email" column found.'); return; }

        const parsed: Recipient[] = lines.slice(1).map(line => {
          const vals: string[] = [];
          let inQ = false, cur = '';
          for (const ch of line) {
            if (ch === '"') inQ = !inQ;
            else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
            else cur += ch;
          }
          vals.push(cur.trim());
          const r: Recipient = { email: vals[idx]?.replace(/^"|"$/g, '').trim() ?? '' };
          headers.forEach((h, i) => { if (i !== idx && vals[i]) r[h] = vals[i].replace(/^"|"$/g, '').trim(); });
          return r;
        }).filter(r => r.email.includes('@'));

        setRecipients(parsed);
        setUploadProgress(null);
        setErrorMsg(null);
        setSuccessMsg(`Loaded ${parsed.length} recipients from ${file.name}`);
      } catch {
        setUploadProgress(null);
        setErrorMsg('Error parsing CSV.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  const handleAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    setAttachments(prev => [...prev, ...files.map(f => ({
      file: f,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }))]);
    e.target.value = '';
  }, []);

  const removeAtt = useCallback((i: number) => {
    setAttachments(prev => { const r = prev[i]; if (r?.preview) URL.revokeObjectURL(r.preview); return prev.filter((_, j) => j !== i); });
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMsg(null); setErrorMsg(null);
    if (!recipients.length) { setErrorMsg('Upload recipients first.'); return; }
    if (!subject.trim())    { setErrorMsg('Subject is required.');     return; }
    if (!emailBody.trim())  { setErrorMsg('Body is required.');        return; }
    sendMutation.mutate({ recipients: recipients.map(r => r.email), subject: subject.trim(), body: emailBody.trim(), attachments: attachments.map(a => a.file) });
  }, [recipients, subject, emailBody, attachments, sendMutation]);

  return (
    <div className="agent-card p-6">
      <h2 className="text-lg font-semibold text-slate-200 mb-1 flex items-center gap-2">
        <Mail size={18} className="text-indigo-400" />
        Email Campaign
      </h2>
      <p className="text-xs text-slate-500 mb-5">Send bulk emails via Gmail. Upload a CSV, compose, and fire.</p>

      {/* Status banners */}
      {successMsg && (
        <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-emerald-900/30 border border-emerald-700/40">
          <CheckCircle size={14} className="text-emerald-400 mt-0.5 shrink-0" />
          <p className="text-xs text-emerald-300 whitespace-pre-wrap">{successMsg}</p>
        </div>
      )}
      {errorMsg && (
        <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-red-900/30 border border-red-700/40">
          <XCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-xs text-red-300">{errorMsg}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* CSV upload */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Recipients (CSV)</label>
          <p className="text-2xs text-slate-500 mb-2">CSV must have an <code className="text-slate-400">email</code> column.</p>
          <label className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg cursor-pointer hover:border-emerald-400/50 transition-colors">
            <Upload size={14} className="text-slate-400" />
            <span className="text-xs text-slate-300">Upload CSV</span>
            <input type="file" accept=".csv" onChange={handleCsvUpload} className="hidden" />
          </label>
          {uploadProgress && (
            <p className="text-2xs text-emerald-400 mt-1 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />{uploadProgress}
            </p>
          )}
          {recipients.length > 0 && (
            <p className="text-xs text-slate-400 mt-1.5">{recipients.length} recipients loaded</p>
          )}
        </div>

        {/* Subject */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Subject</label>
          <input
            type="text" value={subject} onChange={e => setSubject(e.target.value)}
            placeholder="Enter subject…"
            className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-400/60 focus:outline-none transition-colors"
          />
        </div>

        {/* Body */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Body <span className="text-slate-500 font-normal">(HTML supported)</span></label>
          <textarea
            value={emailBody} onChange={e => setEmailBody(e.target.value)}
            placeholder="Write your email…" rows={6}
            className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-400/60 focus:outline-none transition-colors font-mono"
          />
        </div>

        {/* Attachments */}
        <div>
          <label className="block text-sm font-medium text-slate-300 mb-1">Attachments <span className="text-slate-500 font-normal">(optional)</span></label>
          <label className="flex items-center gap-2 px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-lg cursor-pointer hover:border-emerald-400/50 transition-colors">
            <Paperclip size={14} className="text-slate-400" />
            <span className="text-xs text-slate-300">Add files</span>
            <input type="file" multiple accept="image/*,.pdf,.doc,.docx" onChange={handleAttach} className="hidden" />
          </label>
          {attachments.length > 0 && (
            <div className="mt-2 space-y-1">
              {attachments.map((a, i) => (
                <div key={i} className="flex items-center justify-between bg-slate-800/30 rounded px-2 py-1">
                  <span className="text-2xs text-slate-300 truncate">{a.file.name}</span>
                  <button type="button" onClick={() => removeAtt(i)} className="text-red-400 hover:text-red-300 ml-2"><XCircle size={12} /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={sendMutation.isPending}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-700 disabled:cursor-not-allowed text-slate-950 font-semibold rounded-lg transition-colors text-sm"
        >
          {sendMutation.isPending
            ? <><Loader2 size={16} className="animate-spin" />Sending…</>
            : <><Send size={16} />Send Campaign{recipients.length > 0 ? ` (${recipients.length})` : ''}</>}
        </button>
      </form>
    </div>
  );
}
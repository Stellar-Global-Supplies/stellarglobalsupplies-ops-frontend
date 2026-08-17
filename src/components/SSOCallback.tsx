// ─────────────────────────────────────────────────────────────
// SSOCallback.tsx
// Rendered when the landing page opens this app at /sso-callback
//
// Flow:
//   portal.stellarglobalsupplies.com clicks tile
//     → ops.stellarglobalsupplies.com/sso-callback?token=JWT&redirect=/
//   This component POSTs token to the sso-exchange Edge Function
//   → gets a real Supabase session → setSession() → navigate to /
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { supabase } from '@/lib/supabase';

const EXCHANGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sso-exchange`;
const LANDING_URL = (import.meta.env.VITE_LANDING_URL as string | undefined)
  ?? 'https://portal.stellarglobalsupplies.com';

// Replay-attack window: reject SSO URLs older than 5 minutes
const MAX_AGE_MS = 5 * 60 * 1000;

export default function SSOCallback() {
  const [status, setStatus] = useState('Verifying your session…');
  const [error,  setError]  = useState<string | null>(null);

  useEffect(() => {
    const params   = new URLSearchParams(window.location.search);
    const token    = params.get('token');
    const redirect = params.get('redirect') ?? '/';
    const ts       = Number(params.get('ts') ?? 0);

    // ── Guard: stale link ────────────────────────────────────
    if (ts && Date.now() - ts > MAX_AGE_MS) {
      setError('This sign-in link has expired. Please return to the portal.');
      return;
    }

    // ── Guard: no token → send to portal ─────────────────────
    if (!token) {
      const callback = encodeURIComponent(window.location.origin + redirect);
      window.location.replace(`${LANDING_URL}/login?callback=${callback}`);
      return;
    }

    setStatus('Exchanging credentials…');

    fetch(EXCHANGE_FN, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token }),
    })
      .then(res => {
        if (!res.ok) return res.json().then(e => Promise.reject(e));
        return res.json();
      })
      .then(async ({ access_token, refresh_token }: { access_token: string; refresh_token: string }) => {
        setStatus('Setting up workspace…');
        const { error: authErr } = await supabase.auth.setSession({ access_token, refresh_token });
        if (authErr) throw authErr;
        // Clean URL, then hard-navigate so App re-runs auth check with new session
        window.location.replace(redirect);
      })
      .catch((err: unknown) => {
        console.error('SSO callback error:', err);
        const msg = (err as Record<string, string>)?.error ?? 'Sign-in failed. Please return to the portal.';
        setError(msg);
      });
  }, []);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#020617' }}>
        <div className="text-center space-y-4 max-w-sm px-6">
          <p className="text-lg font-bold text-red-400">Sign-in error</p>
          <p className="text-sm text-slate-400">{error}</p>
          <a
            href={LANDING_URL}
            className="inline-block mt-4 px-6 py-2.5 rounded-xl text-sm font-semibold text-slate-950"
            style={{ background: 'linear-gradient(135deg, #00B98E, #00E5FF)' }}
          >
            Return to Portal
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#020617' }}>
      <div className="text-center space-y-6">
        <div className="relative mx-auto w-16 h-16">
          <div className="absolute inset-0 rounded-full border-2 border-transparent animate-spin"
            style={{ borderTopColor: '#00B98E', borderRightColor: 'rgba(0,185,142,0.20)' }} />
          <div className="absolute inset-4 rounded-full flex items-center justify-center"
            style={{ background: 'rgba(0,185,142,0.15)', border: '1px solid rgba(0,185,142,0.40)' }}>
            <Sparkles size={14} style={{ color: '#00B98E' }} />
          </div>
        </div>
        <div>
          <p className="text-base font-bold text-slate-200">SGS Ops</p>
          <p className="text-sm text-slate-500 font-mono mt-1">{status}</p>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SSOCallback.tsx
// Drop into every app at route /sso-callback.
// Configuration is driven entirely by environment variables.
// ─────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

const EXCHANGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sso-exchange`
const LANDING_URL =
  (import.meta.env.VITE_LANDING_URL as string) ||
  'https://apps.stellarglobalsupplies.com'

const MAX_AGE_MS = 5 * 60 * 1000

export default function SSOCallback() {
  const [status, setStatus] = useState('Verifying your session…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    const rawRedirect = params.get('redirect') || '/'

    // Keep navigation strictly same-origin.
    let redirect = '/'
    try {
      const target = new URL(rawRedirect, window.location.origin)

      if (target.origin === window.location.origin) {
        redirect = target.pathname + target.search + target.hash
      }
    } catch {
      redirect = '/'
    }

    /*
     * No token:
     * Return to the portal before checking ts.
     */
    if (!token) {
      const callback = encodeURIComponent(
        window.location.origin + redirect
      )

      window.location.replace(
        `${LANDING_URL}/login?callback=${callback}`
      )

      return
    }

    /*
     * Token exists:
     * ts is mandatory and must be a valid, non-zero,
     * non-future timestamp younger than 5 minutes.
     */
    const rawTs = params.get('ts')

    if (!rawTs) {
      setError(
        'This sign-in link is invalid. Please return to the portal and try again.'
      )
      return
    }

    const ts = Number(rawTs)
    const now = Date.now()

    if (
      !Number.isFinite(ts) ||
      ts <= 0 ||
      ts > now ||
      now - ts > MAX_AGE_MS
    ) {
      setError(
        ts > 0 && ts <= now
          ? 'This sign-in link has expired. Please return to the portal and try again.'
          : 'This sign-in link is invalid. Please return to the portal and try again.'
      )
      return
    }

    setStatus('Exchanging credentials…')

    fetch(EXCHANGE_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async res => {
        const data = await res.json()

        if (!res.ok) {
          throw new Error(
            data.error || `Exchange failed (${res.status})`
          )
        }

        return data
      })
      .then(
        async ({
          access_token,
          refresh_token,
        }: {
          access_token: string
          refresh_token: string
        }) => {
          setStatus('Setting up your workspace…')

          const { error: authErr } =
            await supabase.auth.setSession({
              access_token,
              refresh_token,
            })

          if (authErr) {
            throw new Error(authErr.message)
          }

          // redirect is already restricted to the current origin.
          window.location.replace(redirect)
        }
      )
      .catch((err: Error) => {
        console.error('SSO callback error:', err)

        setError(
          err.message ||
            'Sign-in failed. Please return to the portal and try again.'
        )
      })
  }, [])

  if (error) {
    return (
      <div style={s.page}>
        <div style={s.card}>
          <div style={s.errorDot} />

          <p style={s.errorTitle}>
            Sign-in error
          </p>

          <p style={s.errorMsg}>
            {error}
          </p>

          <a
            href={LANDING_URL}
            style={s.btn}
          >
            Return to Portal
          </a>
        </div>
      </div>
    )
  }

  return (
    <div style={s.page}>
      <div style={s.card}>
        <div style={s.spinWrap}>
          <div style={s.spinner} />
        </div>

        <p style={s.title}>
          Stellar Global Supplies
        </p>

        <p style={s.status}>
          {status}
        </p>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0F172A',
  },

  card: {
    textAlign: 'center',
    padding: '48px 36px',
    borderRadius: 18,
    background: '#1E293B',
    border: '1px solid #334155',
    minWidth: 280,
  },

  spinWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 24,
  },

  spinner: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '3px solid #1E3A5F',
    borderTopColor: '#00B98E',
    animation: 'spin 0.75s linear infinite',
  },

  title: {
    fontSize: 15,
    fontWeight: 700,
    color: '#E2E8F0',
    marginBottom: 8,
  },

  status: {
    fontSize: 13,
    color: '#64748B',
    fontFamily: 'monospace',
  },

  errorDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    background: '#EF4444',
    margin: '0 auto 16px',
  },

  errorTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: '#FCA5A5',
    marginBottom: 8,
  },

  errorMsg: {
    fontSize: 13,
    color: '#94A3B8',
    marginBottom: 24,
    lineHeight: 1.5,
  },

  btn: {
    display: 'inline-block',
    padding: '10px 24px',
    borderRadius: 10,
    background: '#00B98E',
    color: '#0F172A',
    fontWeight: 700,
    fontSize: 13,
    textDecoration: 'none',
  },
}

if (
  typeof document !== 'undefined' &&
  !document.getElementById('sso-spin')
) {
  const style = document.createElement('style')
  style.id = 'sso-spin'
  style.textContent =
    '@keyframes spin { to { transform: rotate(360deg) } }'
  document.head.appendChild(style)
}

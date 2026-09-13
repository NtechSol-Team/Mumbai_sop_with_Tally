'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', margin: 0 }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <h2 style={{ fontSize: 24, fontWeight: 700 }}>Application error</h2>
          <p style={{ color: '#6B7280', maxWidth: 420 }}>{error.message || 'A critical error occurred.'}</p>
          <button onClick={() => reset()} style={{ marginTop: 16, padding: '8px 16px', background: '#234CCE', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer' }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

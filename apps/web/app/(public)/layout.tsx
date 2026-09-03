import Link from 'next/link';
import { Store } from 'lucide-react';

/**
 * Minimal public shell for the policy pages (terms / privacy / refunds).
 * These exist because payment-gateway website verification requires the
 * business's identity and policies to be reachable without a login — the
 * ERP itself stays entirely behind authentication.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <p className="text-label font-bold leading-tight">Mumbai ERP</p>
            <p className="text-caption text-muted-foreground">Mumbai, Maharashtra, India</p>
          </div>
          <Link href="/login" className="ml-auto text-caption font-medium text-primary hover:underline">
            Partner login →
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8">{children}</main>

      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-5 gap-y-1 px-5 py-4 text-caption text-muted-foreground">
          <span>© {new Date().getFullYear()} Mumbai ERP</span>
          <Link href="/terms" className="hover:text-foreground hover:underline">Terms &amp; Conditions</Link>
          <Link href="/privacy" className="hover:text-foreground hover:underline">Privacy Policy</Link>
          <Link href="/refunds" className="hover:text-foreground hover:underline">Cancellations &amp; Refunds</Link>
        </div>
      </footer>
    </div>
  );
}

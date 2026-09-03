'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronLeft, Store, Monitor, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth.store';
import { useUiStore } from '@/store/ui.store';
import { navForRole, POS_HREF } from './nav-config';

function SidebarBody({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  if (!user) return null;

  const items = navForRole(user.role);
  const canUsePos = user.role === 'SUPER_ADMIN' || user.role === 'FRANCHISE_OWNER' || user.role === 'CASHIER';

  return (
    <nav className="flex-1 space-y-1 overflow-y-auto p-2 scrollbar-thin">
      {items.map((item) => {
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2.5 text-body font-medium transition-colors lg:py-2',
              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-foreground hover:bg-surface',
            )}
            title={collapsed ? item.label : undefined}
          >
            <Icon className="h-5 w-5 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        );
      })}

      {canUsePos && (
        <Link
          href={POS_HREF}
          onClick={onNavigate}
          className="mt-2 flex items-center gap-3 rounded-md border border-primary/30 bg-accent px-3 py-2.5 text-body font-semibold text-primary hover:bg-primary/10 lg:py-2"
          title={collapsed ? 'POS' : undefined}
        >
          <Monitor className="h-5 w-5 shrink-0" />
          {!collapsed && <span>Open POS</span>}
        </Link>
      )}
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex h-16 shrink-0 items-center gap-2 border-b border-border px-4">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
        <Store className="h-4 w-4" />
      </div>
      {!collapsed && <span className="truncate font-semibold">Mumbai ERP</span>}
    </div>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const closeMobileNav = useUiStore((s) => s.closeMobileNav);
  const pathname = usePathname();

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    closeMobileNav();
  }, [pathname, closeMobileNav]);

  return (
    <>
      {/* Desktop: sticky, collapsible sidebar. */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-card transition-all lg:flex',
          collapsed ? 'w-16' : 'w-60',
        )}
      >
        <Brand collapsed={collapsed} />
        <SidebarBody collapsed={collapsed} />
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-12 shrink-0 items-center justify-center border-t border-border text-muted-foreground hover:bg-surface"
        >
          <ChevronLeft className={cn('h-5 w-5 transition-transform', collapsed && 'rotate-180')} />
        </button>
      </aside>

      {/* Mobile: off-canvas drawer, opened from the header's hamburger button. */}
      <div className={cn('fixed inset-0 z-40 lg:hidden', mobileNavOpen ? 'pointer-events-auto' : 'pointer-events-none')}>
        <div
          className={cn(
            'absolute inset-0 bg-black/40 transition-opacity duration-200 ease-smooth',
            mobileNavOpen ? 'opacity-100' : 'opacity-0',
          )}
          onClick={closeMobileNav}
          aria-hidden="true"
        />
        <aside
          className={cn(
            'absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-card shadow-nav transition-transform duration-200 ease-smooth',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          )}
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
          role="dialog"
          aria-modal="true"
        >
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
                <Store className="h-4 w-4" />
              </div>
              <span className="truncate font-semibold">Mumbai ERP</span>
            </div>
            <button type="button" onClick={closeMobileNav} className="rounded-md p-1.5 text-muted-foreground hover:bg-surface" aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
          </div>
          <SidebarBody collapsed={false} onNavigate={closeMobileNav} />
        </aside>
      </div>
    </>
  );
}

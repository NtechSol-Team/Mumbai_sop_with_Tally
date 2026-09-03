'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bell, LogOut, Menu, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth.store';
import { useUiStore } from '@/store/ui.store';
import { useLogout } from '@/hooks/useAuth';
import { ROLE_LABEL } from './nav-config';
import { useRealtimeNotifications } from '@/hooks/useRealtime';
import { PrinterSettingsDialog } from '@/components/printer-settings-dialog';

function titleFromPath(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const seg = pathname.split('/').filter(Boolean)[0] ?? '';
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export function Header() {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const openMobileNav = useUiStore((s) => s.openMobileNav);
  const logout = useLogout();
  const { unread, clear } = useRealtimeNotifications();
  const [printerOpen, setPrinterOpen] = useState(false);
  if (!user) return null;

  const initials = user.name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <header
      className="sticky top-0 z-10 flex h-16 items-center justify-between gap-3 border-b border-border bg-card/80 px-4 backdrop-blur sm:px-6"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={openMobileNav}
          className="-ml-1 shrink-0 rounded-md p-2 text-muted-foreground hover:bg-surface lg:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-label font-bold leading-none sm:text-page-heading">{titleFromPath(pathname)}</h1>
          <p className="mt-1 hidden text-caption text-muted-foreground sm:block">Mumbai ERP</p>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {(user.role === 'SUPER_ADMIN' || user.role === 'GODOWN_MANAGER') && (
          <button
            type="button"
            onClick={() => setPrinterOpen(true)}
            className="rounded-md p-2 text-muted-foreground hover:bg-surface"
            aria-label="Printer settings"
            title="Printer settings"
          >
            <Printer className="h-5 w-5" />
          </button>
        )}

        <button
          type="button"
          onClick={clear}
          className="relative rounded-md p-2 text-muted-foreground hover:bg-surface"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>

        <div className="flex items-center gap-3">
          <div className="hidden text-right md:block">
            <p className="text-body font-medium leading-none">{user.name}</p>
            <Badge variant="info" className="mt-1">
              {ROLE_LABEL[user.role]}
            </Badge>
          </div>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-caption font-bold text-primary-foreground">
            {initials}
          </div>
        </div>

        <Button variant="ghost" size="icon" onClick={() => logout.mutate()} aria-label="Sign out" loading={logout.isPending}>
          <LogOut className="h-5 w-5" />
        </Button>
      </div>

      <PrinterSettingsDialog open={printerOpen} onOpenChange={setPrinterOpen} />
    </header>
  );
}

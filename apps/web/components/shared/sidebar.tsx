'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronLeft, Monitor, Search, X, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth.store';
import { useUiStore } from '@/store/ui.store';
import { navForRole, POS_HREF } from './nav-config';
import { Brand } from './brand';

function SidebarBody({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const [search, setSearch] = useState('');
  if (!user) return null;
  const items = navForRole(user.role).filter((item) => collapsed || item.label.toLowerCase().includes(search.toLowerCase()));
  const canUsePos = ['SUPER_ADMIN', 'FRANCHISE_OWNER', 'CASHIER'].includes(user.role);
  return (
    <>
      {!collapsed && <div className="px-4 pb-4 pt-5">
        <div className="relative">
          <Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
          <input aria-label="Find a module" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a module…" className="h-10 w-full rounded-lg border border-white/10 bg-white/5 pl-9 pr-3 text-sm text-white placeholder:text-slate-400 focus:border-blue-400 focus:outline-none" />
        </div>
        <p className="mt-6 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Workspace</p>
      </div>}
      <nav aria-label="Main navigation" className={cn('flex-1 space-y-1 overflow-y-auto px-3 pb-4 scrollbar-thin', collapsed && 'pt-5')}>
        {items.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const Icon = item.icon;
          return <Link key={item.href} href={item.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
            className={cn('group flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors', active ? 'bg-[#2754dd] text-white shadow-md shadow-blue-950/20' : 'text-slate-300 hover:bg-white/[0.07] hover:text-white', collapsed && 'justify-center px-2')}
            title={collapsed ? item.label : undefined} aria-label={collapsed ? item.label : undefined}>
            <Icon aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
            {!collapsed && active && <span aria-hidden="true" className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-200" />}
          </Link>;
        })}
        {!items.length && <p className="px-3 py-4 text-sm text-slate-400">No matching modules.</p>}
      </nav>
      {canUsePos && <div className="shrink-0 px-3 pb-3">
        <Link href={POS_HREF} onClick={onNavigate} aria-label="Open POS" title={collapsed ? 'Open POS' : undefined} className={cn('flex items-center gap-3 rounded-lg border border-white/15 bg-white/5 px-3 py-3 text-[13px] font-medium text-white transition-colors hover:bg-white/10', collapsed && 'justify-center px-2')}>
          <Monitor className="h-[18px] w-[18px] shrink-0" />{!collapsed && <><span>Open POS</span><ArrowUpRight className="ml-auto h-4 w-4 text-slate-400" /></>}
        </Link>
      </div>}
    </>
  );
}

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const closeMobileNav = useUiStore((s) => s.closeMobileNav);
  const pathname = usePathname();
  useEffect(() => { closeMobileNav(); }, [pathname, closeMobileNav]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = () => { if (desktop.matches) closeMobileNav(); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, [closeMobileNav]);
  return <>
    <aside className={cn('arthx-sidebar sticky top-0 hidden h-screen shrink-0 flex-col transition-[width] duration-200 lg:flex', collapsed ? 'w-[76px]' : 'w-[248px]')}>
      <div className={cn('flex h-[76px] shrink-0 items-center justify-center border-b border-white/10', !collapsed && 'bg-white')}><Brand compact={collapsed} /></div>
      <SidebarBody collapsed={collapsed} />
      <button type="button" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed} className="flex h-12 shrink-0 items-center justify-center gap-2 border-t border-white/10 text-xs text-slate-400 hover:bg-white/5 hover:text-white">
        <ChevronLeft className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />{!collapsed && 'Collapse sidebar'}
      </button>
    </aside>
    <Dialog.Root open={mobileNavOpen} onOpenChange={(open) => { if (!open) closeMobileNav(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-950/55 backdrop-blur-sm lg:hidden" />
        <Dialog.Content aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')?.focus(); }} className="arthx-sidebar fixed inset-y-0 left-0 z-50 flex w-[290px] max-w-[90vw] flex-col shadow-nav outline-none lg:hidden">
          <Dialog.Title className="sr-only">Arthx ERP navigation</Dialog.Title>
          <div className="flex h-[76px] shrink-0 items-center justify-between bg-white px-5"><Brand /><Dialog.Close aria-label="Close menu" className="rounded-md p-2 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></Dialog.Close></div>
          <SidebarBody collapsed={false} onNavigate={closeMobileNav} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

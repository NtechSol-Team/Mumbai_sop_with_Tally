import Link from 'next/link';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface KpiCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  changePct?: number;
  href?: string;
  accent?: 'primary' | 'success' | 'warning' | 'danger';
}

const accentBg: Record<NonNullable<KpiCardProps['accent']>, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};

export function KpiCard({ label, value, icon: Icon, changePct, href, accent = 'primary' }: KpiCardProps) {
  const body = (
    <Card className={cn('relative h-full min-h-[130px] overflow-hidden p-5 transition-shadow', href && 'cursor-pointer hover:shadow-md')}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-kpi font-semibold leading-none tracking-tight tabular-nums">{value}</p>
          {changePct !== undefined && (
            <div
              className={cn(
                'mt-2 inline-flex items-center gap-1 text-caption font-semibold',
                changePct >= 0 ? 'text-success' : 'text-danger',
              )}
            >
              {changePct >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
              {Math.abs(changePct)}% vs last month
            </div>
          )}
        </div>
        <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', accentBg[accent])}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Card>
  );

  return href ? <Link href={href} className="block h-full">{body}</Link> : body;
}

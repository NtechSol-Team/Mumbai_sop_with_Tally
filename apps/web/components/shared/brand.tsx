import Image from 'next/image';
import { cn } from '@/lib/utils';

/** Use the supplied wordmark intact, with a separate product descriptor. */
export function Brand({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <div className={cn('inline-flex shrink-0 items-center gap-3', className)} aria-label="Arthx ERP">
      {compact ? (
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white text-xl font-black italic text-primary" aria-hidden="true">AX</span>
      ) : (
        <>
          <Image src="/brand/arthx.png" alt="Arthx" width={6250} height={1804} priority className="h-auto w-[126px] object-contain" />
          <span className="border-l border-slate-300 pl-3 text-[13px] font-semibold tracking-[0.18em] text-slate-600">ERP</span>
        </>
      )}
    </div>
  );
}

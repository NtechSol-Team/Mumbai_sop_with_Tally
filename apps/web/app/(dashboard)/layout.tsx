import { AuthGuard } from '@/components/shared/auth-guard';
import { Sidebar } from '@/components/shared/sidebar';
import { Header } from '@/components/shared/header';
import { OrderPrintListener } from '@/components/orders/order-print-listener';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <OrderPrintListener />
      <a href="#main-content" className="arthx-skip fixed left-4 top-4 z-50 -translate-y-24 rounded-md bg-primary px-4 py-3 text-white focus:translate-y-0">Skip to content</a>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Header />
          <main id="main-content" tabIndex={-1} className="flex-1 p-4 outline-none sm:p-6 xl:p-8">
            <div className="mx-auto w-full max-w-[1280px]">{children}</div>
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}

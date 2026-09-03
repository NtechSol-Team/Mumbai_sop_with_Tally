import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Cancellations & Refunds — Mumbai ERP' };

export default function RefundsPage() {
  return (
    <article className="space-y-5 text-body leading-relaxed">
      <h1 className="text-2xl font-bold">Cancellations &amp; Refunds</h1>
      <p className="text-caption text-muted-foreground">Last updated: 15 July 2026</p>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">1. Cancelling an order</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            An order that has <strong>not yet been paid or approved</strong> can be cancelled by the outlet at
            any time from the portal, free of charge.
          </li>
          <li>
            Cancelling a <strong>confirmed</strong> order (paid online or approved on credit) incurs a{' '}
            <strong>10% cancellation charge</strong>; the remainder of any amount already paid is refunded.
          </li>
          <li>Orders that have already been dispatched cannot be cancelled.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">2. Failed or duplicate payments</h2>
        <p>
          If money is debited but the order is not confirmed (network failure, closed browser, duplicate
          attempt), the payment is either matched to the order automatically or refunded in full by the
          payment gateway. Such refunds are initiated automatically and typically reach the paying account
          within <strong>5–7 working days</strong>, to the same payment method used.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">3. Short or incorrect supply</h2>
        <p>
          If a dispatched order arrives short or incorrect, note it while confirming receipt in the portal
          and inform the main branch the same day. Verified differences are adjusted against the outlet&rsquo;s
          invoice or refunded.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">4. How refunds are issued</h2>
        <p>
          Refunds for online payments are issued through Razorpay to the original payment method. Credit
          adjustments are reflected in the outlet&rsquo;s ledger and next invoice. For any refund query,
          franchise partners can contact the main branch in Mumbai through their relationship contact or the
          details printed on their invoice; we aim to resolve refund queries within 7 working days.
        </p>
      </section>
    </article>
  );
}

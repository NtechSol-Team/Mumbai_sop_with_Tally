import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms & Conditions — Mumbai ERP' };

export default function TermsPage() {
  return (
    <article className="space-y-5 text-body leading-relaxed">
      <h1 className="text-2xl font-bold">Terms &amp; Conditions</h1>
      <p className="text-caption text-muted-foreground">Last updated: 15 July 2026</p>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">1. About this platform</h2>
        <p>
          Mumbai ERP (&ldquo;we&rdquo;) is a food manufacturing and
          franchise business based in Mumbai, Maharashtra, India. This website is our private business-management
          portal: registered franchise outlets use it to order stock from our main branch, receive invoices,
          and pay for those orders. It is not a consumer shopping website; access requires an account issued
          by us to franchise partners and staff.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">2. Orders &amp; payments</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Orders must be placed at least 2 days in advance with advance payment.</li>
          <li>Online payments on this platform are processed securely by Razorpay. We do not collect or store card, UPI, or bank credentials.</li>
          <li>An order is confirmed only after successful online payment, or after credit approval by the main branch.</li>
          <li>If payment is not completed on time, 5% GST may be added to the bill.</li>
          <li>Any changes to a placed order must be informed in advance.</li>
          <li>For pickup after 10 PM, please inform in advance — staff may not be available to verify and hand over material after that time.</li>
          <li>Prices are as quoted in the portal at the time of ordering; invoices state all amounts and applicable GST.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">3. Cancellation</h2>
        <p>
          Cancelling a confirmed order will incur a 10% cancellation charge. See our{' '}
          <a href="/refunds" className="text-primary hover:underline">Cancellations &amp; Refunds policy</a> for details.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">4. Accounts</h2>
        <p>
          Accounts are issued to franchise partners and staff only. You are responsible for keeping your
          credentials confidential and for all activity under your account. We may suspend accounts that
          misuse the platform.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">5. Support &amp; grievances</h2>
        <p>
          Registered franchise partners can reach us for any order, payment, or invoice query through their
          relationship contact at the main branch in Mumbai, or through the contact details printed on their
          invoice. We aim to resolve payment-related queries within 7 working days.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">6. Governing law</h2>
        <p>These terms are governed by the laws of India, with courts in Mumbai, Maharashtra having jurisdiction.</p>
      </section>
    </article>
  );
}

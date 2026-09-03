import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy Policy — Mumbai ERP' };

export default function PrivacyPage() {
  return (
    <article className="space-y-5 text-body leading-relaxed">
      <h1 className="text-2xl font-bold">Privacy Policy</h1>
      <p className="text-caption text-muted-foreground">Last updated: 15 July 2026</p>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">1. What we collect</h2>
        <p>
          This portal is used by our franchise partners and staff. For those account holders we store: name,
          email, phone number, outlet details, and the business records created through normal use — stock
          orders, invoices, payments, and sales entries. We do not track visitors, run advertising, or sell
          data to anyone.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">2. Payments</h2>
        <p>
          Online payments are processed by <strong>Razorpay</strong> (razorpay.com). Your card, UPI, or
          net-banking details are entered directly with Razorpay and never touch our servers; we receive only
          a payment confirmation reference. Razorpay&rsquo;s own privacy policy governs the payment step.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">3. Cookies &amp; storage</h2>
        <p>
          We use browser storage only to keep you signed in and to remember device preferences (such as the
          receipt-printer configuration on POS devices). No third-party analytics or advertising cookies are used.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">4. Retention &amp; security</h2>
        <p>
          Business records (orders, invoices, payments) are retained as required for accounting and GST
          compliance. Access is restricted by role-based accounts over encrypted (HTTPS) connections.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-label font-semibold">5. Your rights &amp; contact</h2>
        <p>
          Franchise partners may ask us to correct or update their account information at any time through
          their relationship contact at the main branch in Mumbai, or via the contact details printed on their
          invoice.
        </p>
      </section>
    </article>
  );
}

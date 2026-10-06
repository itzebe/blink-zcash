'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Shell, TopBar } from '@/components/Shell';
import { BlinkPaymentCard } from '@/components/BlinkPaymentCard';

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

export default function HomePage() {
  const [demoAmount, setDemoAmount] = useState('0.25');
  const [demoMemo, setDemoMemo] = useState('Coffee & croissant');

  return (
    <Shell>
      <TopBar network={NETWORK} />

      <div className="stack" style={{ gap: 32 }}>
        <div className="stack stack--sm" style={{ textAlign: 'center' }}>
          <p className="kicker">Private payments</p>
          <h1 style={{ fontSize: 'clamp(32px, 8vw, 48px)' }}>
            Send money.
            <br />
            <span style={{ color: 'var(--accent)' }}>Not your wallet address.</span>
          </h1>
          <p className="lede" style={{ maxWidth: 440, margin: '0 auto' }}>
            BLINK turns any Zcash payment into a private digital link. Non-custodial, ZIP 321
            compliant, and honest about privacy: shielded when your address is shielded.
          </p>
        </div>

        {/* Central Interactive Payment Card */}
        <BlinkPaymentCard
          amount={demoAmount || '0.00'}
          currency="ZEC"
          memo={demoMemo}
          recipientName="Joseph"
          network={NETWORK}
          actions={
            <>
              <Link className="btn btn--primary" href="/request">
                Request
              </Link>
              <Link className="btn btn--ghost" href="/scan">
                Pay / Scan
              </Link>
            </>
          }
        >
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div className="field">
              <span className="field__label">Try interactive preview</span>
              <div className="btn-row" style={{ marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setDemoAmount('0.10');
                    setDemoMemo('Coffee');
                  }}
                >
                  0.10 ZEC · Coffee
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => {
                    setDemoAmount('1.50');
                    setDemoMemo('Dinner');
                  }}
                >
                  1.50 ZEC · Dinner
                </button>
              </div>
            </div>
          </div>
        </BlinkPaymentCard>

        {/* How it works visual loop */}
        <div className="stack stack--sm">
          <p className="kicker">Request · Share · Scan · Pay</p>
          <div className="actions">
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                1
              </span>
              <div>
                <span className="action__title">Create Request</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  Set an amount and optional memo. Your recipient address stays encrypted on the server.
                </span>
              </div>
            </div>
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                2
              </span>
              <div>
                <span className="action__title">Share Payment Link</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  Send the generated short link in chat or present the ZIP 321 QR code.
                </span>
              </div>
            </div>
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                3
              </span>
              <div>
                <span className="action__title">Pay Privately</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  The payer opens their Zcash wallet and approves the payment. Shielded addresses
                  keep the recipient and amount private.
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Real-World Use Cases */}
        <div className="stack stack--sm">
          <p className="kicker">Shielded Use Cases</p>
          <div className="card stack stack--sm">
            <div className="row" style={{ paddingTop: 0 }}>
              <div>
                <strong style={{ display: 'block', fontSize: 15 }}>Point of Sale</strong>
                <span className="tiny muted">
                  Merchant creates a short-expiry request → customer scans the QR → instant payment
                </span>
              </div>
            </div>
            <div className="row">
              <div>
                <strong style={{ display: 'block', fontSize: 15 }}>Remittance &amp; Sharing</strong>
                <span className="tiny muted">
                  Send a payment link in messaging apps without revealing wallet addresses
                </span>
              </div>
            </div>
            <div className="row">
              <div>
                <strong style={{ display: 'block', fontSize: 15 }}>Private Payroll &amp; Invoicing</strong>
                <span className="tiny muted">
                  Request exact amounts with a memo attached to the payment request
                </span>
              </div>
            </div>
            <div className="row">
              <div>
                <strong style={{ display: 'block', fontSize: 15 }}>Subscriptions</strong>
                <span className="tiny muted">
                  Issue a fresh recurring request each period — never an automatic charge
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Built on Zcash section */}
        <div className="card card--accent center stack stack--sm" style={{ padding: '24px 20px' }}>
          <p className="kicker" style={{ color: 'var(--accent)' }}>Built on Zcash Protocol</p>
          <h2 style={{ fontSize: 18 }}>Shielded Payment Infrastructure</h2>
          <p className="tiny muted" style={{ maxWidth: 420, margin: '0 auto' }}>
            Zcash provides zero-knowledge cryptography that protects financial privacy. BLINK adds a
            clean payment request layer using the ZIP 321 standard, and states the actual privacy of
            each route rather than over-promising.
          </p>
        </div>

        <p className="footer-note">
          Non-custodial · BLINK never holds your funds or spending keys
        </p>
      </div>
    </Shell>
  );
}

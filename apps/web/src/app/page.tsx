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
            BLINK turns any Zcash payment into a private digital link. Non-custodial, instant, shielded.
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

        {/* How it works visual sections */}
        <div className="stack stack--sm">
          <p className="kicker">How BLINK works</p>
          <div className="actions">
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                1
              </span>
              <div>
                <span className="action__title">Create a payment object</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  Set an amount and an optional memo. Your address stays private behind the link.
                </span>
              </div>
            </div>
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                2
              </span>
              <div>
                <span className="action__title">Share the link or QR</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  Send the payment URL in chat or show the ZIP 321 QR code in person.
                </span>
              </div>
            </div>
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                3
              </span>
              <div>
                <span className="action__title">Payer approves in wallet</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  The payer opens their Zcash wallet and signs the transaction privately.
                </span>
              </div>
            </div>
          </div>
        </div>

        <p className="footer-note">
          Non-custodial · BLINK never holds your funds or spending keys
        </p>
      </div>
    </Shell>
  );
}

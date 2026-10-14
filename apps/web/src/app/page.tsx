'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppFrame, NetworkPill } from '@/components/Shell';
import { BlinkPaymentCard } from '@/components/BlinkPaymentCard';
import { useConnection } from '@/components/ConnectionProvider';

/**
 * The homepage. It explains the product in the order a new visitor needs:
 * what BLINK is, how a payment link works, why the recipient policy is
 * shielded-first, and how (and how far) BLINK can verify a payment.
 *
 * Nothing here invents activity: the preview is a real component with example
 * values, and the copy matches the shipped behaviour.
 */
export default function HomePage() {
  // The confirmed network, or null until the API answers. The preview badge
  // shows a neutral label rather than guessing a network.
  const { network } = useConnection();
  const [demoAmount, setDemoAmount] = useState('0.25');
  const [demoMemo, setDemoMemo] = useState('Coffee');

  return (
    <AppFrame wide>
      <div className="stack stack--lg">
        {/* Hero ---------------------------------------------------------- */}
        <section className="hero">
          <div className="hero__grid">
            <div>
              <span className="hero__eyebrow">
                Shielded-first Zcash payments
                <NetworkPill network={network} />
              </span>
              <h1 className="hero__title">
                Send money privately.
                <br />
                Share a <em>simple link</em>.
              </h1>
              <p className="hero__lede">
                BLINK helps you create and share Zcash payment requests, with a shielded-first
                approach to privacy and transaction verification. The recipient address stays
                encrypted on the server and never appears in the link you share.
              </p>
              <div className="hero__actions">
                <Link className="btn btn--primary" href="/checkout">
                  Start a checkout
                </Link>
                <Link className="btn btn--ghost" href="/request">
                  Create a payment request
                </Link>
              </div>
              <div className="trust-row">
                <span className="trust-item">Non-custodial — never holds your funds</span>
                <span className="trust-item">Built on the ZIP 321 standard</span>
                <span className="trust-item">No account or seed phrase required</span>
              </div>
            </div>

            <div className="hero__preview">
              <BlinkPaymentCard
                amount={demoAmount}
                currency="ZEC"
                memo={demoMemo}
                recipientName="Your name"
                network={network}
              >
                <div className="stack stack--sm" style={{ marginTop: 18 }}>
                  <span className="field__label" style={{ color: 'var(--on-navy-muted)' }}>
                    Example request — try it
                  </span>
                  <div className="btn-row">
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
              </BlinkPaymentCard>
            </div>
          </div>
        </section>

        {/* What BLINK is ------------------------------------------------- */}
        <section className="section">
          <div className="section__head">
            <p className="kicker">What BLINK is</p>
            <h2 className="section__title">A payment request, not a wallet</h2>
            <p className="section__lede">
              BLINK is a non-custodial interface for requesting Zcash. You describe the payment,
              BLINK encodes it as a standard <code>zcash:</code> request, and you share a short
              link. BLINK never holds funds, keys, or seed phrases.
            </p>
          </div>

          <div className="actions">
            <div className="action">
              <span className="action__icon" aria-hidden="true">
                1
              </span>
              <div>
                <span className="action__title">Create Request</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  Set an amount and an optional memo. Your recipient address is encrypted at rest
                  and never appears in the shareable link.
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
                  Send the generated short link, or present the ZIP 321 QR code for a wallet to
                  scan. The QR encodes the payment request itself, not a web page.
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
                  The payer approves the payment inside their own Zcash wallet. BLINK never signs
                  or sends a transaction.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Full lifecycle, including verification ------------------------ */}
        <section className="section">
          <div className="section__head">
            <p className="kicker">From request to verified payment</p>
            <h2 className="section__title">Four steps, and an honest check</h2>
            <p className="section__lede">
              Request creation, payment, blockchain confirmation and verification are separate
              stages. BLINK keeps them separate too, so a submitted transaction is never shown as
              a confirmed payment.
            </p>
          </div>
          <div className="flow">
            <div className="flow__step">
              <span className="flow__num">01</span>
              <p className="flow__title">Create a payment request</p>
              <p className="flow__desc">
                BLINK validates the recipient address and builds a ZIP 321 URI with the amount and
                optional memo.
              </p>
            </div>
            <div className="flow__step">
              <span className="flow__num">02</span>
              <p className="flow__title">Share the link</p>
              <p className="flow__desc">
                Anyone with the link opens a confirmation page that states what the route protects
                before anything is paid.
              </p>
            </div>
            <div className="flow__step">
              <span className="flow__num">03</span>
              <p className="flow__title">The payer pays</p>
              <p className="flow__desc">
                The payer approves the payment in their wallet. BLINK hands over the payment
                request; it cannot move funds.
              </p>
            </div>
            <div className="flow__step">
              <span className="flow__num">04</span>
              <p className="flow__title">BLINK checks the evidence</p>
              <p className="flow__desc">
                BLINK observes the transaction through a configured provider and reports only what
                it can actually establish.
              </p>
            </div>
          </div>
        </section>

        {/* Shielded-first and verification ------------------------------- */}
        <section className="section">
          <div className="section__head">
            <p className="kicker">Why shielded-first</p>
            <h2 className="section__title">Privacy the protocol can actually deliver</h2>
            <p className="section__lede">
              On Zcash, a shielded recipient and amount are protected on-chain. BLINK refuses a
              recipient that can only be paid transparently, because that would expose the payment
              publicly.
            </p>
          </div>
          <div className="features">
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ◈
              </span>
              <p className="feature__title">Shielded recipients only</p>
              <p className="feature__desc">
                A transparent address, or a Unified Address that also exposes a transparent
                receiver, is rejected in the primary flow. BLINK will not hand a payer an address
                that could settle publicly.
              </p>
            </div>
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ⌗
              </span>
              <p className="feature__title">Standard ZIP 321 requests</p>
              <p className="feature__desc">
                Amounts and memos follow the ZIP 321 payment-request format, so a compatible wallet
                can read the request directly. There is no proprietary payment format.
              </p>
            </div>
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ✓
              </span>
              <p className="feature__title">Verification that stays honest</p>
              <p className="feature__desc">
                BLINK reports a payment as confirmed only after a configured provider observes the
                transaction at the required depth. A transaction id on its own never confirms a
                payment.
              </p>
            </div>
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ⛓
              </span>
              <p className="feature__title">Non-custodial by design</p>
              <p className="feature__desc">
                BLINK never asks for a seed phrase or spending key, never signs, and never
                broadcasts. The payer keeps full control in their own wallet.
              </p>
            </div>
          </div>
        </section>

        {/* Privacy and its limits ---------------------------------------- */}
        <section className="section">
          <div className="card card--pad-lg">
            <p className="kicker">What privacy means here</p>
            <h2 className="section__title" style={{ marginTop: 8 }}>
              Shielded-first, and clear about the limits
            </h2>
            <div className="stack stack--sm" style={{ marginTop: 16 }}>
              <p className="lede">
                A shielded recipient address does not, by itself, prove that the payer used a
                shielded receiver. A compatible wallet is free to choose which receiver it pays.
                BLINK can confirm that a shielded receiver exists in the address you gave, but not
                that the payer used it.
              </p>
              <p className="lede">
                On-chain, Zcash protects a shielded recipient and amount. BLINK itself still stores
                the request: the recipient address is encrypted at rest and kept out of the link,
                but the memo is stored and shown in plaintext.
              </p>
              <Link className="btn btn--ghost" href="/litepaper" style={{ width: 'auto' }}>
                Read the full privacy model →
              </Link>
            </div>
          </div>
        </section>

        {/* Use cases ----------------------------------------------------- */}
        <section className="section">
          <div className="section__head">
            <p className="kicker">Potential use cases</p>
            <h2 className="section__title">Where a payment link fits</h2>
            <p className="section__lede">
              These are realistic applications of the existing product, not claims about current
              adoption.
            </p>
          </div>
          <div className="features">
            <div className="feature">
              <p className="feature__title">Freelance and invoicing</p>
              <p className="feature__desc">
                Request an exact amount with a memo for reference, and share one link per invoice.
              </p>
            </div>
            <div className="feature">
              <p className="feature__title">Donations</p>
              <p className="feature__desc">
                Publish a request so supporters can pay without seeing your wallet address in the
                link.
              </p>
            </div>
            <div className="feature">
              <p className="feature__title">Online commerce</p>
              <p className="feature__desc">
                A short-expiry request for a point-of-sale or checkout flow, paid by scanning the
                QR code.
              </p>
            </div>
            <div className="feature">
              <p className="feature__title">Peer-to-peer requests</p>
              <p className="feature__desc">
                Ask a friend for a specific amount over a messaging app, with the privacy of the
                route stated up front.
              </p>
            </div>
          </div>
        </section>

        {/* Merchant ----------------------------------------------------- */}
        <section className="section">
          <div className="section__head">
            <p className="kicker">For merchants</p>
            <h2 className="section__title">Take a payment at the counter</h2>
            <p className="section__lede">
              A checkout built for a phone on a counter: enter an amount, show the QR code, and
              watch one screen for the real status. Every request you create is kept in this
              browser so you can review it later.
            </p>
          </div>
          <div className="features">
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ⚡
              </span>
              <p className="feature__title">Fast checkout</p>
              <p className="feature__desc">
                Enter an amount in USD or ZEC and present the ZIP 321 QR code to the payer.
              </p>
            </div>
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ◉
              </span>
              <p className="feature__title">Honest status</p>
              <p className="feature__desc">
                The screen separates a payer-reported id from a transaction BLINK actually
                observed, and never shows a sale as confirmed before it is.
              </p>
            </div>
            <div className="feature">
              <span className="feature__icon" aria-hidden="true">
                ▤
              </span>
              <p className="feature__title">Your workspace</p>
              <p className="feature__desc">
                Review the requests this browser created, share them, and open a receipt once a
                payment is confirmed.
              </p>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 20 }}>
            <Link className="btn btn--primary" href="/checkout">
              Open merchant checkout
            </Link>
            <Link className="btn btn--ghost" href="/merchant">
              View your workspace
            </Link>
          </div>
        </section>

        {/* CTA ----------------------------------------------------------- */}
        <section className="cta-band">
          <h2>Create your first payment request</h2>
          <p>
            No account, no seed phrase, no custody. Build a ZIP 321 request in a few seconds and
            share the link.
          </p>
          <Link className="btn btn--accent" href="/request">
            Create a payment request
          </Link>
        </section>
      </div>
    </AppFrame>
  );
}

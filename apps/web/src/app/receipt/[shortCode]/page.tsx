'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { privacyHeadline } from '@blink/shared';
import { Shell, TopBar, Alert, Row } from '@/components/Shell';
import { PrivacyPanel } from '@/components/PrivacyPanel';
import { api, ApiError, type Receipt } from '@/lib/api';
import { purposeLabel } from '@/lib/status';

export default function ReceiptPage({ params }: { params: Promise<{ shortCode: string }> }) {
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    params.then((p) => setShortCode(p.shortCode));
  }, [params]);

  useEffect(() => {
    if (!shortCode) return;
    api
      .receipt(shortCode)
      .then((res) => setReceipt(res.receipt))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Could not load this receipt.'),
      )
      .finally(() => setLoading(false));
  }, [shortCode]);

  /**
   * Share the receipt link. The receipt is already public (it is fetched from
   * the same short code), so nothing sensitive leaves the browser: no address,
   * no key, no server detail. Uses the native share sheet where available and
   * falls back to copying the link.
   */
  async function shareReceipt() {
    if (!receipt) return;
    const url = `${window.location.origin}/receipt/${receipt.shortCode}`;
    const summary = `${privacyHeadline(receipt.privacy)} · ${receipt.amount} ZEC${
      receipt.usdAmount ? ` ($${receipt.usdAmount} USD requested)` : ''
    } · ${purposeLabel(receipt.purpose)}`;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'BLINK receipt', text: summary, url });
        return;
      } catch {
        /* user cancelled; fall back to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Receipt link copied.');
    } catch {
      setNotice('Could not copy the receipt link. Select the link manually.');
    }
  }

  return (
    <Shell>
      <TopBar network={receipt?.network === 'mainnet' ? 'mainnet' : 'testnet'} />
      <div className="stack">
        <div className="stack stack--sm center">
          {receipt ? (
            <div className="success-mark" aria-hidden="true">
              ✓
            </div>
          ) : null}
          <p className="kicker">
            {receipt ? `Receipt · ${purposeLabel(receipt.purpose)}` : 'Proof of payment'}
          </p>
          <h1>Payment complete</h1>
        </div>

        {loading ? <p className="lede">Loading receipt…</p> : null}
        {error ? <Alert kind="error">{error}</Alert> : null}

        {receipt ? (
          <>
            <div className="card card--accent">
              <h2 className="amount-hero" style={{ fontSize: 44 }}>
                {receipt.amount}
                <span>ZEC</span>
              </h2>
              <p className="tiny muted" style={{ marginTop: 4 }}>
                Settled amount
              </p>
              <div style={{ marginTop: 14 }}>
                {receipt.usdAmount ? (
                  <Row label="Original requested amount">${receipt.usdAmount} USD</Row>
                ) : (
                  <Row label="Original requested amount">Not denominated in USD</Row>
                )}
                <Row label="Settled amount">{receipt.amount} ZEC</Row>
                {receipt.usdAmount ? (
                  <Row label="Rate at request">
                    1 ZEC = ${receipt.zecUsdPrice} USD
                  </Row>
                ) : null}
                <Row label="Status">Confirmed</Row>
                <Row label="Network">
                  {receipt.network === 'mainnet' ? 'Zcash mainnet' : 'Zcash testnet'}
                </Row>
                <Row label="Privacy status">{privacyHeadline(receipt.privacy)}</Row>
                <Row label="Purpose">{purposeLabel(receipt.purpose)}</Row>
                {receipt.memo ? <Row label="Memo">{receipt.memo}</Row> : null}
                {receipt.txid ? (
                  <Row label="Transaction">
                    <span className="mono tiny">{receipt.txid}</span>
                  </Row>
                ) : null}
                <Row label="Observed">{new Date(receipt.paidAt).toLocaleString()}</Row>
              </div>
            </div>

            {receipt.privacy ? <PrivacyPanel privacy={receipt.privacy} /> : null}

            <Alert kind="info">{receipt.statement}</Alert>

            {notice ? <Alert kind="warn">{notice}</Alert> : null}

            <div className="btn-row">
              <button type="button" className="btn btn--primary" onClick={shareReceipt}>
                Share receipt
              </button>
              <Link className="btn btn--ghost" href="/">
                Done
              </Link>
            </div>
          </>
        ) : null}
      </div>
      <p className="footer-note">BLINK does not claim selective disclosure for shielded payments</p>
    </Shell>
  );
}

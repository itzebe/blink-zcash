'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, TopBar, Alert, Row } from '@/components/Shell';
import { PrivacyPanel } from '@/components/PrivacyPanel';
import { api, ApiError, type Receipt } from '@/lib/api';
import { purposeLabel } from '@/lib/status';

export default function ReceiptPage({ params }: { params: Promise<{ shortCode: string }> }) {
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <Shell>
      <TopBar network={receipt?.network === 'mainnet' ? 'mainnet' : 'testnet'} />
      <div className="stack">
        <div className="stack stack--sm">
          <p className="kicker">{receipt ? purposeLabel(receipt.purpose) : 'Proof of payment'}</p>
          <h1>Payment verified</h1>
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
              {receipt.usdAmount ? (
                <p className="tiny muted" style={{ marginTop: 4 }}>
                  Requested ${receipt.usdAmount} USD · converted at 1 ZEC = ${receipt.zecUsdPrice}{' '}
                  USD
                </p>
              ) : null}
              <div style={{ marginTop: 14 }}>
                <Row label="Status">{receipt.status}</Row>
                <Row label="Network">
                  {receipt.network === 'mainnet' ? 'Zcash Mainnet' : 'Zcash Testnet'}
                </Row>
                <Row label="Confirmations">{receipt.confirmations}</Row>
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

            <Link className="btn btn--ghost" href="/">
              Done
            </Link>
          </>
        ) : null}
      </div>
      <p className="footer-note">BLINK does not claim selective disclosure for shielded payments</p>
    </Shell>
  );
}

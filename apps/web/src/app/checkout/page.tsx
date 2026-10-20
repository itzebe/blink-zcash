'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  convertUsdToZec,
  settledZecAmount,
  type PaymentPurpose,
} from '@blink/shared';
import { AppFrame, Alert } from '@/components/Shell';
import { QrCode } from '@/components/QrCode';
import { PrivacyPanel } from '@/components/PrivacyPanel';
import { StatusPanel } from '@/components/StatusPanel';
import { VerificationBadge } from '@/components/VerificationBadge';
import { useConnection } from '@/components/ConnectionProvider';
import { api, ApiError, type CreatedPaymentRequest, type PublicPaymentRequest } from '@/lib/api';
import { purposeLabel } from '@/lib/status';
import { previewRecipient } from '@/lib/privacy-preview';
import { addWorkspaceEntry, saveManagementToken } from '@/lib/workspace';

const QUICK_AMOUNTS = ['5', '10', '20', '50'];

function previewZec(usd: string, price: string | null): string | null {
  if (!price || !usd.trim()) return null;
  try {
    return settledZecAmount(convertUsdToZec(usd.trim(), price));
  } catch {
    return null;
  }
}

/**
 * Merchant checkout: the fast path for a face-to-face sale.
 *
 * The merchant enters an amount, presents the QR code, and watches one screen
 * for the status to move from "waiting" to "observed" to "confirmed". Every
 * status is the backend's own — the screen polls the same public projection the
 * payer sees, and it never shows a confirmed sale BLINK has not observed. It
 * reuses the exact request-creation, USD conversion and shielded-only policy the
 * rest of the app uses; there is no parallel payment path.
 */
export default function CheckoutPage() {
  const { network, ready } = useConnection();

  const [recipientName, setRecipientName] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<'USD' | 'ZEC'>('USD');
  // A counter sale is a point-of-sale request with a short expiry; the merchant
  // is not asked to configure these for a face-to-face charge.
  const purpose: PaymentPurpose = 'point_of_sale';
  const expiryMinutes = 10;
  const [memo, setMemo] = useState('');

  const [price, setPrice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPaymentRequest | null>(null);
  const [live, setLive] = useState<PublicPaymentRequest | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const preview = network ? previewRecipient(recipientAddress, network) : null;
  const rejected = preview?.rejected ?? false;

  // Remember the merchant's own name/address across charges in this session.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('blink:checkout:merchant');
      if (saved) {
        const parsed = JSON.parse(saved) as { name?: string; address?: string };
        if (parsed.name) setRecipientName(parsed.name);
        if (parsed.address) setRecipientAddress(parsed.address);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (currency !== 'USD' || !ready) {
      setPrice(null);
      return;
    }
    let cancelled = false;
    api
      .getZecUsdPrice()
      .then((res) => {
        if (!cancelled) setPrice(res.price.price);
      })
      .catch(() => {
        if (!cancelled) setPrice(null);
      });
    return () => {
      cancelled = true;
    };
  }, [currency, ready]);

  const zecPreview = currency === 'USD' ? previewZec(amount, price) : null;

  const current = live ?? created?.request ?? null;
  const status = current?.status ?? null;

  // Poll the request while it is still payable, so the merchant sees the real
  // transition to observed/confirmed without touching anything.
  useEffect(() => {
    if (!created) return;
    const code = created.shortCode;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { request } = await api.getPaymentRequest(code);
        setLive(request);
        if (!['CREATED', 'WAITING_FOR_PAYMENT', 'PAYMENT_INITIATED', 'TRANSACTION_CREATED', 'BROADCAST', 'CONFIRMING'].includes(request.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        /* transient; keep polling */
      }
    }, 4000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [created]);

  async function createCharge(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createPaymentRequest({
        recipientName: recipientName.trim(),
        recipientAddress: recipientAddress.trim(),
        amount: amount.trim(),
        currency,
        purpose,
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        expiryMinutes,
      });
      setCreated(result);
      setLive(result.request);
      setCopied(false);
      saveManagementToken(result.shortCode, result.managementToken);
      addWorkspaceEntry({
        shortCode: result.shortCode,
        label: result.request.recipientName || 'Checkout',
        createdAt: result.request.createdAt,
      });
      try {
        window.localStorage.setItem(
          'blink:checkout:merchant',
          JSON.stringify({ name: recipientName.trim(), address: recipientAddress.trim() }),
        );
      } catch {
        /* ignore */
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'engine_unavailable') {
        setError(
          'The Zcash validation service is still waking up. This can take about a minute — please try again.',
        );
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  function newCharge() {
    if (pollRef.current) clearInterval(pollRef.current);
    setCreated(null);
    setLive(null);
    setAmount('');
    setMemo('');
    setError(null);
  }

  async function copyLink() {
    if (!created) return;
    const url = `${window.location.origin}/pay/${created.shortCode}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Copy failed. Select the link manually.');
    }
  }

  async function shareLink() {
    if (!created) return;
    const url = `${window.location.origin}/pay/${created.shortCode}`;
    const text = `Pay ${created.request.amount} ZEC with BLINK:\n${url}`;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'BLINK payment request', text, url });
        return;
      } catch {
        /* cancelled; fall through to copy */
      }
    }
    await copyLink();
  }

  const confirmed = status === 'CONFIRMED';

  return (
    <AppFrame>
      {created && current ? (
        <div className="stack checkout">
          <div className="stack stack--sm" style={{ textAlign: 'center' }}>
            <p className="kicker">{purposeLabel(current.purpose)}</p>
            <h1>{confirmed ? 'Payment received' : 'Charge in progress'}</h1>
          </div>

          <div className="checkout__grid">
            <div className="checkout__qr card card--accent">
              <p className="checkout__amount">
                {current.amount}
                <span className="checkout__amount-symbol">ZEC</span>
              </p>
              {current.usdAmount ? (
                <p className="tiny muted">≈ ${current.usdAmount} USD requested</p>
              ) : null}
              <QrCode
                value={created.zip321Uri}
                size={260}
                label="ZIP 321 payment request QR code — scan with a Zcash wallet"
              />
              <p className="tiny muted center">
                Ask the payer to scan this with a compatible Zcash wallet. The code is the payment
                request itself, not a web link.
              </p>
            </div>

            <div className="checkout__side stack stack--sm">
              <StatusPanel status={status ?? 'WAITING_FOR_PAYMENT'} confirmations={current.confirmations} />

              {current.shieldedVerification ? (
                <VerificationBadge record={current.shieldedVerification} />
              ) : null}

              {confirmed ? (
                <Link className="btn btn--primary" href={`/receipt/${created.shortCode}`}>
                  View receipt
                </Link>
              ) : null}

              <div className="btn-row">
                <button type="button" className="btn btn--ghost btn--small" onClick={shareLink}>
                  Share link
                </button>
                <button type="button" className="btn btn--ghost btn--small" onClick={copyLink}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>

              <Link className="btn btn--ghost btn--small" href={`/pay/${created.shortCode}`}>
                Open payer view
              </Link>

              <button type="button" className="btn btn--primary" onClick={newCharge}>
                New charge
              </button>

              <PrivacyPanel privacy={current.privacy} compact />

              <details className="tech">
                <summary>Details</summary>
                <div className="tech__body">
                  <div>Encoding: ZIP 321</div>
                  <div>Network: {current.network}</div>
                  <div>Short code: {created.shortCode}</div>
                  {current.usdAmount ? (
                    <div>
                      Converted at 1 ZEC = ${current.zecUsdPrice} USD ({current.priceProvider})
                    </div>
                  ) : null}
                  <div>{created.zip321Uri}</div>
                </div>
              </details>
            </div>
          </div>

          {!confirmed ? (
            <Alert kind="info">
              This screen keeps checking the network. A request is confirmed only after BLINK
              observes the transaction at the required depth; you can leave it open on the counter.
            </Alert>
          ) : null}
        </div>
      ) : (
        <form className="stack" onSubmit={createCharge}>
          <div className="stack stack--sm">
            <p className="kicker">Merchant checkout</p>
            <h1>Charge a customer.</h1>
            <p className="lede">
              Enter an amount, show the QR code, and watch the payment status update on one screen.
            </p>
          </div>

          {error ? <Alert kind="error">{error}</Alert> : null}

          <div className="field">
            <div className="field__label-row">
              <label className="field__label" htmlFor="amount">
                Amount
              </label>
              <div className="segmented segmented--sm" role="radiogroup" aria-label="Currency">
                {(['USD', 'ZEC'] as const).map((c) => (
                  <span key={c}>
                    <input
                      type="radio"
                      id={`checkout-currency-${c}`}
                      name="checkout-currency"
                      checked={currency === c}
                      onChange={() => setCurrency(c)}
                    />
                    <label htmlFor={`checkout-currency-${c}`}>{c}</label>
                  </span>
                ))}
              </div>
            </div>
            <div className="amount-input">
              <span className="prefix" aria-hidden="true">
                {currency === 'USD' ? '$' : 'ⓩ'}
              </span>
              <input
                id="amount"
                className="input"
                inputMode="decimal"
                autoComplete="off"
                placeholder={currency === 'USD' ? '20.00' : '0.5'}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
              <span className="suffix" aria-hidden="true">
                {currency}
              </span>
            </div>
            <div className="mode-chips" role="group" aria-label="Quick amount">
              {QUICK_AMOUNTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="mode-chip"
                  aria-pressed={amount === q}
                  onClick={() => setAmount(q)}
                >
                  {currency === 'USD' ? `$${q}` : `${q} ZEC`}
                </button>
              ))}
            </div>
            {currency === 'USD' ? (
              <p className="tiny muted" aria-live="polite">
                {price && zecPreview
                  ? `1 ZEC = $${price} USD · you'll request ≈ ${zecPreview} ZEC`
                  : price
                    ? `1 ZEC = $${price} USD`
                    : 'Fetching live ZEC/USD price…'}
              </p>
            ) : (
              <p className="tiny muted">Amount is denominated in ZEC.</p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="memo">
              Reference (optional)
            </label>
            <input
              id="memo"
              className="input"
              placeholder="Table 4 / order 128"
              maxLength={512}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
            <p className="tiny muted">
              Stored and shown in plaintext. Use a reference, not anything secret.
            </p>
          </div>

          <details className="card">
            <summary>Merchant details</summary>
            <div className="stack stack--sm" style={{ marginTop: 12 }}>
              <div className="field">
                <label className="field__label" htmlFor="name">
                  Business or your name
                </label>
                <input
                  id="name"
                  className="input"
                  placeholder="Corner Cafe"
                  maxLength={64}
                  autoComplete="name"
                  value={recipientName}
                  onChange={(e) => setRecipientName(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="address">
                  Your Zcash address
                </label>
                <input
                  id="address"
                  className="input input--mono"
                  placeholder={network === 'mainnet' ? 'u1… or zs1…' : 'utest… or ztestsapling…'}
                  autoComplete="off"
                  spellCheck={false}
                  value={recipientAddress}
                  onChange={(e) => setRecipientAddress(e.target.value)}
                  required
                />
                <p className="tiny muted">
                  Kept on the server, encrypted, and never placed in the link you share.
                </p>
                {preview?.privacy ? <PrivacyPanel privacy={preview.privacy} compact /> : null}
                {rejected ? (
                  <Alert kind="error">
                    BLINK requires a shielded-only recipient. This address can also receive
                    transparently, so a wallet could settle the payment publicly on-chain. Use a
                    Sapling address or a shielded-only Unified Address.
                  </Alert>
                ) : null}
                {preview?.error ? <Alert kind="warn">{preview.error}</Alert> : null}
              </div>
            </div>
          </details>

          <button className="btn btn--primary" type="submit" disabled={busy || !ready || rejected}>
            {busy ? 'Creating…' : !ready ? 'Connecting…' : 'Start charge'}
          </button>
          {!ready ? (
            <p className="tiny muted center">
              Waiting for the BLINK service to confirm the Zcash network before a charge can start.
            </p>
          ) : null}
        </form>
      )}
      <p className="footer-note">Non-custodial · BLINK never holds your funds or your keys</p>
    </AppFrame>
  );
}

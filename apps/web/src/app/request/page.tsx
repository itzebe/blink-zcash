'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { convertUsdToZec, settledZecAmount } from '@blink/shared';
import { Shell, TopBar, Alert } from '@/components/Shell';
import { BlinkPaymentCard } from '@/components/BlinkPaymentCard';
import { api, ApiError, type CreatedPaymentRequest } from '@/lib/api';

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

const EXPIRY_OPTIONS = [
  { value: 10, label: '10 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '24 hours' },
];

type RequestCurrency = 'USD' | 'ZEC';

/** Best-effort client-side preview of the server's USD -> ZEC conversion. */
function previewZec(usd: string, price: string | null): string | null {
  if (!price || !usd.trim()) return null;
  try {
    return settledZecAmount(convertUsdToZec(usd.trim(), price));
  } catch {
    return null;
  }
}

export default function RequestPage() {
  const [recipientName, setRecipientName] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [currency, setCurrency] = useState<RequestCurrency>('ZEC');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [expiryMinutes, setExpiryMinutes] = useState(30);

  const [price, setPrice] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPaymentRequest | null>(null);
  const [copied, setCopied] = useState(false);

  // Preview the live rate only when the request is USD-denominated. The server
  // re-fetches the price at creation; this preview is informational.
  useEffect(() => {
    if (currency !== 'USD') {
      setPrice(null);
      setPriceError(null);
      return;
    }
    let cancelled = false;
    setPriceError(null);
    api
      .getZecUsdPrice()
      .then((res) => {
        if (!cancelled) setPrice(res.price.price);
      })
      .catch((err) => {
        if (!cancelled) {
          setPrice(null);
          setPriceError(
            err instanceof ApiError ? err.message : 'Live ZEC/USD price is unavailable.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currency]);

  const zecPreview = currency === 'USD' ? previewZec(amount, price) : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createPaymentRequest({
        recipientName: recipientName.trim(),
        recipientAddress: recipientAddress.trim(),
        amount: amount.trim(),
        currency,
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        expiryMinutes,
      });
      setCreated(result);
      try {
        window.localStorage.setItem(`blink:manage:${result.shortCode}`, result.managementToken);
      } catch {
        /* storage may be unavailable; not fatal */
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    if (!created) return;
    const text = `Pay me privately with BLINK:\n${created.shareUrl}`;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ title: 'BLINK payment request', text, url: created.shareUrl });
        return;
      } catch {
        /* user cancelled; fall back to copy */
      }
    }
    await copyLink();
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Copy failed. Select the link manually.');
    }
  }

  if (created) {
    return (
      <Shell>
        <TopBar network={created.request.network} />
        <div className="stack">
          <div className="stack stack--sm" style={{ textAlign: 'center' }}>
            <p className="kicker">Payment object ready</p>
            <h1>Share your private request.</h1>
            <p className="lede">
              Anyone with this link can pay you. Your Zcash address stays hidden on the server.
            </p>
          </div>

          {/* Generated Digital Payment Card */}
          <BlinkPaymentCard
            amount={created.request.amount}
            currency="ZEC"
            usdAmount={created.request.usdAmount}
            memo={created.request.memo}
            recipientName={created.request.recipientName}
            network={created.request.network}
            status={created.request.status}
            statusLabel="Waiting for payment"
            statusTone="waiting"
            zip321Uri={created.zip321Uri}
            shareUrl={created.shareUrl}
            actions={
              <>
                <button type="button" className="btn btn--primary" onClick={share}>
                  Share
                </button>
                <button type="button" className="btn btn--ghost" onClick={copyLink}>
                  {copied ? 'Copied link' : 'Copy link'}
                </button>
              </>
            }
          >
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <Link className="btn btn--ghost" href={`/pay/${created.shortCode}`}>
                Open payer view →
              </Link>
            </div>
          </BlinkPaymentCard>

          <details className="tech">
            <summary>View technical details</summary>
            <div className="tech__body">
              <div>Encoding: ZIP 321 Payment Request URI</div>
              <div>Network: {created.request.network}</div>
              <div>Short Code: {created.shortCode}</div>
              {created.request.usdAmount ? (
                <div>
                  Requested: ${created.request.usdAmount} USD · converted at 1 ZEC = $
                  {created.request.zecUsdPrice} USD ({created.request.priceProvider})
                </div>
              ) : null}
              <div>{created.zip321Uri}</div>
            </div>
          </details>

          <p className="tiny muted center">
            Expires {new Date(created.request.expiresAt).toLocaleString()}.
          </p>
        </div>
        <p className="footer-note">Non-custodial · BLINK never holds your funds</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <TopBar network={NETWORK} />
      <form className="stack" onSubmit={submit}>
        <div className="stack stack--sm">
          <p className="kicker">Request payment</p>
          <h1>Get paid with a link.</h1>
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
                    id={`currency-${c}`}
                    name="currency"
                    checked={currency === c}
                    onChange={() => setCurrency(c)}
                  />
                  <label htmlFor={`currency-${c}`}>{c}</label>
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
              placeholder={currency === 'USD' ? '25.00' : '0.625'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <span className="suffix" aria-hidden="true">
              {currency}
            </span>
          </div>
          {currency === 'USD' ? (
            <p className="tiny muted" aria-live="polite">
              {priceError
                ? priceError
                : price && zecPreview
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
          <span className="field__label">Expires</span>
          <div className="segmented" role="radiogroup" aria-label="Expiry">
            {EXPIRY_OPTIONS.map((option) => (
              <span key={option.value}>
                <input
                  type="radio"
                  id={`expiry-${option.value}`}
                  name="expiry"
                  checked={expiryMinutes === option.value}
                  onChange={() => setExpiryMinutes(option.value)}
                />
                <label htmlFor={`expiry-${option.value}`}>{option.label}</label>
              </span>
            ))}
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="memo">
            Memo (optional)
          </label>
          <input
            id="memo"
            className="input"
            placeholder="Dinner"
            maxLength={512}
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="name">
            Your name
          </label>
          <input
            id="name"
            className="input"
            placeholder="Joseph"
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
            placeholder="u1… or ztestsapling…"
            autoComplete="off"
            spellCheck={false}
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            required
          />
          <p className="tiny muted">
            Stays on the server behind this link. It never appears in the shareable URL.
          </p>
        </div>

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create payment'}
        </button>
      </form>
      <p className="footer-note">BLINK never asks for your seed phrase or spending key</p>
    </Shell>
  );
}

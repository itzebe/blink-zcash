'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { convertUsdToZec, settledZecAmount, privacyCapability, shieldedOnlyPolicy, withUnifiedReceivers, type PrivacyCapability, type PaymentPurpose } from '@blink/shared';
import { parseAddress } from '@blink/zcash';
import { Shell, TopBar, Alert } from '@/components/Shell';
import { BlinkPaymentCard } from '@/components/BlinkPaymentCard';
import { PrivacyPanel } from '@/components/PrivacyPanel';
import { useConnection } from '@/components/ConnectionProvider';
import { api, ApiError, type CreatedPaymentRequest } from '@/lib/api';
import { purposeLabel } from '@/lib/status';

const EXPIRY_OPTIONS = [
  { value: 10, label: '10 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '24 hours' },
];

type RequestCurrency = 'USD' | 'ZEC';

/**
 * Lightweight use-case presets over the ONE request flow. Each mode only
 * pre-fills the same payment request; there is no separate mini-app and no
 * fabricated transaction. `subscription` is deliberately a payment-request
 * workflow, not autonomous recurring charging: BLINK cannot and does not move
 * funds on the payer's behalf.
 */
interface UseCaseMode {
  id: string;
  label: string;
  amount: string;
  currency: RequestCurrency;
  memo: string;
  expiryMinutes: number;
  hint: string;
}

const MODES: UseCaseMode[] = [
  {
    id: 'invoice',
    label: 'Invoice',
    amount: '25',
    currency: 'USD',
    memo: 'Invoice',
    expiryMinutes: 1440,
    hint: 'A private invoice. Share the link; your address stays out of it.',
  },
  {
    id: 'point_of_sale',
    label: 'Point of sale',
    amount: '5',
    currency: 'USD',
    memo: 'Point of sale',
    expiryMinutes: 10,
    hint: 'A quick in-person charge with a short expiry.',
  },
  {
    id: 'payroll',
    label: 'Payroll',
    amount: '850',
    currency: 'USD',
    memo: 'Salary',
    expiryMinutes: 1440,
    hint: 'A salary payment request you can send to each team member.',
  },
  {
    id: 'remittance',
    label: 'Remittance',
    amount: '200',
    currency: 'USD',
    memo: 'Remittance',
    expiryMinutes: 1440,
    hint: 'A cross-border transfer request. The recipient address never appears in the link.',
  },
  {
    id: 'subscription',
    label: 'Subscription',
    amount: '15',
    currency: 'USD',
    memo: 'Monthly subscription',
    expiryMinutes: 1440,
    hint: 'A recurring request. BLINK issues a fresh, dated request each period; it never charges automatically and holds no funds.',
  },
];

/** The everyday workflow each preset maps to (the API `purpose` field). */
const MODE_PURPOSE: Record<string, PaymentPurpose> = {
  invoice: 'invoice',
  point_of_sale: 'point_of_sale',
  payroll: 'payroll',
  remittance: 'remittance',
  subscription: 'subscription',
};

/** Best-effort client-side preview of the server's USD -> ZEC conversion. */
function previewZec(usd: string, price: string | null): string | null {
  if (!price || !usd.trim()) return null;
  try {
    return settledZecAmount(convertUsdToZec(usd.trim(), price));
  } catch {
    return null;
  }
}

/**
 * Best-effort client-side preview of the recipient route. The server recomputes
 * and stores the authoritative capability at creation; this is only so the
 * recipient sees — before they submit — whether BLINK's shielded-only policy
 * would accept the address. It applies the exact same policy as the API, so a
 * mixed (transparent-bearing) or unconfirmable address is shown as rejected
 * rather than described as shielded.
 */
function previewPrivacy(
  address: string,
  network: 'testnet' | 'mainnet',
): { privacy: PrivacyCapability | null; rejected: boolean } {
  if (!address.trim()) return { privacy: null, rejected: false };
  try {
    const parsed = parseAddress(address.trim());
    if (parsed.network !== network) return { privacy: null, rejected: false };
    const verdict = shieldedOnlyPolicy(parsed.receivers);
    if (!verdict.ok) return { privacy: null, rejected: true };
    return {
      privacy: withUnifiedReceivers(privacyCapability(parsed.kind), verdict.receivers),
      rejected: false,
    };
  } catch {
    return { privacy: null, rejected: false };
  }
}

export default function RequestPage() {
  const { network, ready } = useConnection();
  const [recipientName, setRecipientName] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [currency, setCurrency] = useState<RequestCurrency>('ZEC');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [expiryMinutes, setExpiryMinutes] = useState(30);
  const [mode, setMode] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<PaymentPurpose>('invoice');

  const [price, setPrice] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedPaymentRequest | null>(null);
  const [copied, setCopied] = useState(false);

  const privacyPreview = network ? previewPrivacy(recipientAddress, network) : null;
  const recipientRejected = privacyPreview?.rejected ?? false;

  function applyMode(next: UseCaseMode) {
    setMode(next.id);
    setAmount(next.amount);
    setCurrency(next.currency);
    setMemo(next.memo);
    setExpiryMinutes(next.expiryMinutes);
    setPurpose(MODE_PURPOSE[next.id] ?? 'invoice');
  }

  // Preview the live rate only when the request is USD-denominated. The server
  // re-fetches the price at creation; this preview is informational.
  useEffect(() => {
    if (currency !== 'USD') {
      setPrice(null);
      setPriceError(null);
      return;
    }
    // Don't probe the price while the backend is still waking: that would show a
    // spurious error. Wait until the network is confirmed.
    if (!ready) {
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
  }, [currency, ready]);

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
        purpose,
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
            <p className="kicker">{purposeLabel(created.request.purpose)}</p>
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
            privacy={created.request.privacy}
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

          {/* Privacy of the created route, exactly as the server stored it. */}
          <PrivacyPanel privacy={created.request.privacy} />

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
      <TopBar network={network} />
      <form className="stack" onSubmit={submit}>
        <div className="stack stack--sm">
          <p className="kicker">Request payment</p>
          <h1>Get paid with a link.</h1>
        </div>

        {/* Presets pre-fill the same request flow; the Purpose control below is
            the label actually stored on the request. */}
        <div className="field">
          <span className="field__label">Start from a preset</span>
          <div className="mode-chips" role="group" aria-label="Preset">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className="mode-chip"
                aria-pressed={mode === m.id}
                onClick={() => applyMode(m)}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode ? (
            <p className="mode-chip__hint">{MODES.find((m) => m.id === mode)?.hint}</p>
          ) : null}
        </div>

        <div className="field">
          <span className="field__label" id="purpose-label">
            Purpose
          </span>
          <div
            className="segmented segmented--sm segmented--wrap"
            role="radiogroup"
            aria-labelledby="purpose-label"
          >
            {(Object.keys(MODE_PURPOSE) as Array<keyof typeof MODE_PURPOSE>).map((id) => (
              <span key={id}>
                <input
                  type="radio"
                  id={`purpose-${id}`}
                  name="purpose"
                  checked={purpose === MODE_PURPOSE[id]}
                  onChange={() => setPurpose(MODE_PURPOSE[id])}
                />
                <label htmlFor={`purpose-${id}`}>{purposeLabel(MODE_PURPOSE[id])}</label>
              </span>
            ))}
          </div>
          <p className="tiny muted">
            A label for your own reference. It never changes how the request settles — every request
            is a ZIP 321 payment in ZEC.
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
            placeholder={
              network === 'mainnet' ? 'u1… or zs1… or t1…' : 'utest… or ztestsapling…'
            }
            autoComplete="off"
            spellCheck={false}
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            required
          />
          <p className="tiny muted">
            Stays on the server behind this link. It never appears in the shareable URL.
          </p>
          {/* Privacy of the route, computed from the actual receiver composition. */}
          {privacyPreview?.privacy ? (
            <PrivacyPanel privacy={privacyPreview.privacy} compact />
          ) : null}
          {recipientRejected ? (
            <Alert kind="error">
              BLINK requires a shielded-only recipient. This address can also receive
              transparently (it carries a transparent receiver), so a wallet could settle the
              payment publicly on-chain. Use a Sapling address or a shielded-only Unified Address.
            </Alert>
          ) : null}
        </div>

        <button
          className="btn btn--primary"
          type="submit"
          disabled={busy || !ready || recipientRejected}
        >
          {busy ? 'Creating…' : !ready ? 'Connecting…' : 'Create payment'}
        </button>
        {!ready ? (
          <p className="tiny muted center">
            Waiting for the BLINK service to confirm the Zcash network before a request can be
            created.
          </p>
        ) : null}
      </form>
      <p className="footer-note">BLINK never asks for your seed phrase or spending key</p>
    </Shell>
  );
}

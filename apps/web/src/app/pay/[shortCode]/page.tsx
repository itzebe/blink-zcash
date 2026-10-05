'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Shell, TopBar, Alert, Row, StatusBadge } from '@/components/Shell';
import { BlinkPaymentCard } from '@/components/BlinkPaymentCard';
import { api, ApiError, type PaymentDetails, type PublicPaymentRequest } from '@/lib/api';
import { statusLabel, statusTone, statusIsVerified } from '@/lib/status';

type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string; code?: string }
  | { name: 'ready' }
  | { name: 'confirm' }
  | { name: 'processing' }
  | { name: 'claim' }
  | { name: 'done' }
  | { name: 'paid' };

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

export default function PayPage({ params }: { params: Promise<{ shortCode: string }> }) {
  const [shortCode, setShortCode] = useState<string | null>(null);
  const [request, setRequest] = useState<PublicPaymentRequest | null>(null);
  const [details, setDetails] = useState<PaymentDetails | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  const [txidInput, setTxidInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    params.then((p) => setShortCode(p.shortCode));
  }, [params]);

  const load = useCallback(async (code: string) => {
    try {
      const [{ request: req }, det] = await Promise.all([
        api.getPaymentRequest(code),
        api.getPaymentDetails(code).catch(() => null),
      ]);
      setRequest(req);
      if (det) setDetails(det);
      if (req.status === 'CONFIRMED') setPhase({ name: 'paid' });
      else if (req.status === 'EXPIRED')
        setPhase({ name: 'error', message: 'This payment request has expired.', code: 'expired' });
      else if (req.status === 'CANCELLED')
        setPhase({
          name: 'error',
          message: 'This payment request was cancelled.',
          code: 'cancelled',
        });
      else setPhase((p) => (p.name === 'loading' ? { name: 'ready' } : p));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPhase({
          name: 'error',
          message: 'This payment request was not found.',
          code: 'not_found',
        });
      } else if (err instanceof ApiError && err.status === 410) {
        setPhase({ name: 'error', message: 'This payment request has expired.', code: 'expired' });
      } else {
        setPhase({
          name: 'error',
          message: err instanceof Error ? err.message : 'Could not load payment request.',
        });
      }
    }
  }, []);

  useEffect(() => {
    if (shortCode) void load(shortCode);
  }, [shortCode, load]);

  // Poll while a transaction is in flight. Polling never invents state: it asks
  // the API, which asks the verification provider.
  useEffect(() => {
    if (!shortCode) return;
    const active = ['BROADCAST', 'CONFIRMING', 'TRANSACTION_CREATED'];
    if (!request || !active.includes(request.status)) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const { request: req } = await api.getPaymentRequest(shortCode);
        setRequest(req);
        if (req.status === 'CONFIRMED') {
          setPhase({ name: 'paid' });
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
        /* transient; keep polling */
      }
    }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [shortCode, request]);

  async function openConfirm() {
    if (!shortCode) return;
    setNotice(null);
    try {
      const { request: req } = await api.initiate(shortCode);
      setRequest(req);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'already_paid') {
        setPhase({ name: 'paid' });
        return;
      }
      if (err instanceof ApiError && (err.code === 'expired' || err.code === 'cancelled')) {
        setPhase({ name: 'error', message: err.message, code: err.code });
        return;
      }
      // Non-fatal: still allow confirmation attempt.
    }
    setPhase({ name: 'confirm' });
  }

  function payWithWallet() {
    if (!details) return;
    setPhase({ name: 'processing' });
    // Hand off to the wallet via the ZIP 321 URI. BLINK never signs anything; the
    // user approves inside their own wallet.
    try {
      window.location.href = details.zip321Uri;
    } catch {
      /* Some browsers block custom schemes; the manual path below remains. */
    }
    setTimeout(() => setPhase({ name: 'claim' }), 1200);
  }

  async function copyUri() {
    if (!details) return;
    try {
      await navigator.clipboard.writeText(details.zip321Uri);
      setCopied(true);
      setNotice('Payment request copied. Paste it into your Zcash wallet.');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setNotice('Could not copy. Select the URI manually.');
    }
  }

  async function submitTxid(event: React.FormEvent) {
    event.preventDefault();
    if (!shortCode || !txidInput.trim()) return;
    setNotice(null);
    try {
      await api.claimTxid(shortCode, txidInput.trim());
      await api.verify(shortCode).catch(() => null);
      const { request: req } = await api.getPaymentRequest(shortCode);
      setRequest(req);
      setPhase({ name: 'done' });
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not record the transaction id.');
    }
  }

  if (phase.name === 'loading') {
    return (
      <Shell>
        <TopBar network={NETWORK} />
        <p className="lede">Loading payment request…</p>
      </Shell>
    );
  }

  if (phase.name === 'error' && !request) {
    return (
      <Shell>
        <TopBar network={NETWORK} />
        <div className="stack">
          <div className="stack stack--sm">
            <p className="kicker">Payment request</p>
            <h1>{phase.code === 'expired' ? 'Payment request expired' : 'Not found'}</h1>
          </div>
          <Alert kind="error">{phase.message}</Alert>
          <Link className="btn btn--primary" href="/request">
            Create a new request
          </Link>
        </div>
      </Shell>
    );
  }

  if (!request) return null;
  const network = request.network;

  if (phase.name === 'paid') {
    return (
      <Shell>
        <TopBar network={network} />
        <div className="stack center">
          <div className="success-mark" aria-hidden="true">
            ✓
          </div>
          <div className="stack stack--sm">
            <p className="kicker">Payment confirmed</p>
            <h1 className="amount-hero">
              {request.amount}
              <span>ZEC</span>
            </h1>
            {request.memo ? <p className="lede">{request.memo}</p> : null}
          </div>
          <div className="card">
            <Row label="Recipient">{request.recipientName}</Row>
            <Row label="Network">{network === 'mainnet' ? 'Zcash Mainnet' : 'Zcash Testnet'}</Row>
            <Row label="Confirmations">{request.confirmations}</Row>
            {request.txidShort ? <Row label="Transaction">{request.txidShort}</Row> : null}
          </div>
          <Link className="btn btn--ghost" href={`/receipt/${request.shortCode}`}>
            View receipt
          </Link>
        </div>
      </Shell>
    );
  }

  if (phase.name === 'done') {
    const verified = statusIsVerified(request.status);
    return (
      <Shell>
        <TopBar network={network} />
        <div className="stack">
          <div className="stack stack--sm">
            <p className="kicker">Transaction recorded</p>
            <h1>{verified ? 'Payment observed' : 'Waiting for confirmation'}</h1>
            <p className="lede">
              {verified
                ? 'BLINK observed your transaction on the Zcash network.'
                : 'BLINK recorded the transaction id you provided. It has not yet observed it on the network, so this is not confirmation.'}
            </p>
          </div>
          <div className="card">
            <Row label="Amount">{request.amount} ZEC</Row>
            <Row label="Recipient">{request.recipientName}</Row>
            <Row label="Status">
              <StatusBadge
                status={request.status}
                label={statusLabel(request.status)}
                tone={statusTone(request.status)}
              />
            </Row>
            {request.txidShort ? <Row label="Transaction">{request.txidShort}</Row> : null}
          </div>
          <Alert kind="info">
            Confirmation can take a few minutes. You can safely close this page; BLINK keeps
            checking.
          </Alert>
        </div>
      </Shell>
    );
  }

  if (phase.name === 'claim') {
    return (
      <Shell>
        <TopBar network={network} />
        <form className="stack" onSubmit={submitTxid}>
          <div className="stack stack--sm">
            <p className="kicker">Payment sent?</p>
            <h1>Confirm it.</h1>
            <p className="lede">
              Paste the transaction id from your wallet so BLINK can check it against the Zcash
              network.
            </p>
          </div>
          {notice ? <Alert kind="warn">{notice}</Alert> : null}
          <div className="field">
            <label className="field__label" htmlFor="txid">
              Transaction id
            </label>
            <input
              id="txid"
              className="input input--mono"
              placeholder="64 hex characters"
              spellCheck={false}
              autoComplete="off"
              value={txidInput}
              onChange={(e) => setTxidInput(e.target.value)}
            />
          </div>
          <button className="btn btn--primary" type="submit" disabled={!txidInput.trim()}>
            Check payment
          </button>
          <Alert kind="info">
            A transaction id on its own does not prove payment. BLINK only marks a request confirmed
            after it independently observes the transaction.
          </Alert>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setPhase({ name: 'ready' })}
          >
            Back
          </button>
        </form>
      </Shell>
    );
  }

  if (phase.name === 'processing') {
    return (
      <Shell>
        <TopBar network={network} />
        <div className="stack">
          <div className="stack stack--sm">
            <p className="kicker">Payment processing</p>
            <h1>Preparing private payment…</h1>
            <p className="lede">Your wallet should now be open. Approve the payment there.</p>
          </div>
          <Alert kind="warn">
            BLINK does not sign or send transactions. Your wallet does. If your wallet did not open,
            use the button below.
          </Alert>
          <button className="btn btn--ghost" onClick={() => setPhase({ name: 'claim' })}>
            I sent it — enter transaction id
          </button>
        </div>
      </Shell>
    );
  }

  if (phase.name === 'confirm') {
    return (
      <Shell>
        <TopBar network={network} />
        <div className="stack">
          <div className="stack stack--sm">
            <p className="kicker">Confirm payment</p>
            <h1>{request.amount} ZEC</h1>
          </div>
          {notice ? <Alert kind="warn">{notice}</Alert> : null}
          <div className="card">
            <Row label="Amount">{request.amount} ZEC</Row>
            <Row label="Recipient">{request.recipientName}</Row>
            {request.memo ? <Row label="Memo">{request.memo}</Row> : null}
            <Row label="Network">{network === 'mainnet' ? 'Zcash Mainnet' : 'Zcash Testnet'}</Row>
            <Row label="Payment type">Shielded where the recipient supports it</Row>
          </div>
          <button className="btn btn--primary" onClick={payWithWallet}>
            Confirm payment
          </button>
          <button className="btn btn--ghost" onClick={() => setPhase({ name: 'ready' })}>
            Cancel
          </button>
          <p className="tiny muted">
            Your wallet will ask you to approve. BLINK cannot move funds on your behalf.
          </p>
        </div>
      </Shell>
    );
  }

  // Ready
  return (
    <Shell>
      <TopBar network={network} />
      <div className="stack">
        <div className="stack stack--sm" style={{ textAlign: 'center' }}>
          <p className="kicker">Private Payment Request</p>
          <h1>{request.recipientName} requested a payment</h1>
        </div>

        {/* Digital Payment Card Confirmation Screen */}
        <BlinkPaymentCard
          amount={request.amount}
          currency="ZEC"
          memo={request.memo}
          recipientName={request.recipientName}
          network={network}
          status={request.status}
          statusLabel={statusLabel(request.status)}
          statusTone={statusTone(request.status)}
          actions={
            <>
              <button type="button" className="btn btn--primary" onClick={openConfirm}>
                Pay with Zcash
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={copyUri}
                disabled={!details}
              >
                {copied ? 'Copied request' : 'Copy request'}
              </button>
            </>
          }
        >
          {notice ? <Alert kind="warn">{notice}</Alert> : null}
        </BlinkPaymentCard>

        {details ? (
          <details className="tech">
            <summary>View details</summary>
            <div className="tech__body">
              <div>Encoding: ZIP 321</div>
              <div>Network: {details.network}</div>
              {details.addressKind ? <div>Address type: {details.addressKind}</div> : null}
              {details.addressFingerprint ? (
                <div>Recipient fingerprint: {details.addressFingerprint}</div>
              ) : null}
              <div>{details.zip321Uri}</div>
            </div>
          </details>
        ) : null}

        <p className="tiny muted center">
          PRIVATE PAYMENT · Protected by Zcash shielded protocol
        </p>
      </div>
    </Shell>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppFrame, Alert, Row } from '@/components/Shell';
import { StatusPanel } from '@/components/StatusPanel';
import { useConnection } from '@/components/ConnectionProvider';
import { api, ApiError, type PublicPaymentRequest } from '@/lib/api';
import { isPayableStatus, purposeLabel } from '@/lib/status';
import {
  listWorkspaceEntries,
  readManagementToken,
  removeWorkspaceEntry,
  type WorkspaceEntry,
} from '@/lib/workspace';

interface LoadedRow {
  entry: WorkspaceEntry;
  request: PublicPaymentRequest | null;
  error: string | null;
}

/**
 * The merchant workspace: a per-device review of the requests this browser
 * created. It is not an account and holds no balances — every value comes from
 * the public payment-request projection, and the only privileged action
 * (cancel) uses the per-request management token this browser stored at
 * creation. Nothing here aggregates revenue or invents history.
 */
export default function MerchantPage() {
  const { ready } = useConnection();
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [rows, setRows] = useState<LoadedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyCode, setBusyCode] = useState<string | null>(null);

  useEffect(() => {
    setEntries(listWorkspaceEntries());
  }, []);

  const refresh = useCallback(async (list: WorkspaceEntry[]) => {
    setLoading(true);
    const loaded = await Promise.all(
      list.map(async (entry): Promise<LoadedRow> => {
        try {
          const { request } = await api.getPaymentRequest(entry.shortCode);
          return { entry, request, error: null };
        } catch (err) {
          const message =
            err instanceof ApiError && err.status === 404
              ? 'This request no longer exists on the server.'
              : 'Could not load this request right now.';
          return { entry, request: null, error: message };
        }
      }),
    );
    setRows(loaded);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refresh(entries);
  }, [ready, entries, refresh]);

  const { active, history } = useMemo(() => {
    const active: LoadedRow[] = [];
    const history: LoadedRow[] = [];
    for (const row of rows) {
      const status = row.request?.status ?? 'UNKNOWN';
      if (isPayableStatus(status)) active.push(row);
      else history.push(row);
    }
    return { active, history };
  }, [rows]);

  async function copyLink(shortCode: string) {
    const url = `${window.location.origin}/pay/${shortCode}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice('Payment link copied.');
    } catch {
      setNotice('Could not copy the link. Open the request and copy it there.');
    }
  }

  async function cancel(shortCode: string) {
    const token = readManagementToken(shortCode);
    if (!token) {
      setNotice('This device does not hold the management token for that request.');
      return;
    }
    setBusyCode(shortCode);
    setNotice(null);
    try {
      await api.cancel(shortCode, token);
      await refresh(entries);
      setNotice('Request cancelled.');
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not cancel the request.');
    } finally {
      setBusyCode(null);
    }
  }

  function forget(shortCode: string) {
    removeWorkspaceEntry(shortCode);
    setEntries(listWorkspaceEntries());
  }

  function renderRow(row: LoadedRow) {
    const { entry, request } = row;
    const status = request?.status ?? 'UNKNOWN';
    const payable = isPayableStatus(status);
    const token = readManagementToken(entry.shortCode);
    return (
      <div className="req-row" key={entry.shortCode} data-status={status}>
        <div className="req-row__main">
          <div className="req-row__top">
            <span className="req-row__label">{entry.label}</span>
            {request ? (
              <span className="req-row__amount">
                {request.amount} <span className="muted">ZEC</span>
                {request.usdAmount ? (
                  <span className="tiny muted"> · ${request.usdAmount} USD</span>
                ) : null}
              </span>
            ) : null}
          </div>
          <div className="req-row__meta">
            <span className="mono tiny">{entry.shortCode}</span>
            {request ? <span className="tiny muted"> · {purposeLabel(request.purpose)}</span> : null}
          </div>
        </div>

        {request ? (
          <StatusPanel status={status} confirmations={request.confirmations} />
        ) : (
          <Alert kind="warn">{row.error}</Alert>
        )}

        <div className="btn-row">
          <Link className="btn btn--ghost btn--small" href={`/pay/${entry.shortCode}`}>
            Open
          </Link>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => copyLink(entry.shortCode)}
          >
            Copy link
          </button>
          {status === 'CONFIRMED' ? (
            <Link className="btn btn--primary btn--small" href={`/receipt/${entry.shortCode}`}>
              Receipt
            </Link>
          ) : null}
          {payable && token ? (
            <button
              type="button"
              className="btn btn--danger btn--small"
              disabled={busyCode === entry.shortCode}
              onClick={() => cancel(entry.shortCode)}
            >
              {busyCode === entry.shortCode ? 'Cancelling…' : 'Cancel'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--small"
            onClick={() => forget(entry.shortCode)}
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <AppFrame>
      <div className="stack">
        <div className="stack stack--sm">
          <p className="kicker">Merchant workspace</p>
          <h1>Your payment requests</h1>
          <p className="lede">
            Requests created in this browser are listed here so you can review their status, share
            them, and open a receipt once a payment is confirmed.
          </p>
        </div>

        <Alert kind="info">
          This workspace lives in this browser only. BLINK has no accounts: there is no login, no
          balance and no cross-device sync. Clearing site data removes this list.
        </Alert>

        {notice ? <Alert kind="warn">{notice}</Alert> : null}

        <div className="btn-row">
          <Link className="btn btn--primary" href="/request">
            New payment request
          </Link>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void refresh(entries)}
            disabled={!ready || loading}
          >
            {loading ? 'Refreshing…' : 'Refresh statuses'}
          </button>
        </div>

        {!ready ? (
          <p className="tiny muted">
            Connecting to the BLINK service. Statuses shown will refresh once the network is
            confirmed.
          </p>
        ) : null}

        {entries.length === 0 && !loading ? (
          <div className="card">
            <Row label="No requests yet">
              <Link href="/request">Create your first payment request</Link>
            </Row>
          </div>
        ) : null}

        {active.length > 0 ? (
          <section className="stack stack--sm">
            <h2 className="section__title">Active requests</h2>
            <p className="tiny muted">
              These requests can still be paid. A request shows as confirmed only after BLINK
              observes the transaction on the Zcash network.
            </p>
            <div className="req-list">{active.map(renderRow)}</div>
          </section>
        ) : null}

        {history.length > 0 ? (
          <section className="stack stack--sm">
            <h2 className="section__title">History</h2>
            <p className="tiny muted">
              Closed requests: confirmed, expired, cancelled or failed. Nothing here is a balance —
              it is the recorded outcome of each request.
            </p>
            <div className="req-list">{history.map(renderRow)}</div>
          </section>
        ) : null}
      </div>
      <p className="footer-note">Non-custodial · BLINK never holds your funds or your keys</p>
    </AppFrame>
  );
}

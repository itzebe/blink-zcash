import { StatusBadge } from './Shell';
import {
  statusDetail,
  statusEvidence,
  statusLabel,
  statusTone,
  type StatusEvidence,
} from '@/lib/status';

const EVIDENCE_LABEL: Record<StatusEvidence, string> = {
  none: 'No payment evidence yet',
  claimed: 'Payer-reported — not observed',
  observed: 'Observed on-chain',
  final: 'Closed',
};

/**
 * The honest payment status, in one place: the status name, a plain sentence of
 * what it means, and the evidence behind it.
 *
 * The evidence tag is the point. "Transaction reported" and "Confirmed" both
 * describe a payment, but only the latter is backed by a provider observation.
 * Rendering the distinction next to every status keeps a merchant from reading a
 * claimed txid as a completed sale.
 */
export function StatusPanel({ status, confirmations }: { status: string; confirmations?: number }) {
  const evidence = statusEvidence(status);
  return (
    <div className="status-panel" data-status={status} data-evidence={evidence}>
      <div className="status-panel__head">
        <StatusBadge status={status} label={statusLabel(status)} tone={statusTone(status)} />
        <span className={`evidence-tag evidence-tag--${evidence}`}>{EVIDENCE_LABEL[evidence]}</span>
      </div>
      <p className="status-panel__detail">{statusDetail(status)}</p>
      {evidence === 'observed' && typeof confirmations === 'number' ? (
        <p className="tiny muted">
          {confirmations} confirmation{confirmations === 1 ? '' : 's'} observed so far.
        </p>
      ) : null}
    </div>
  );
}

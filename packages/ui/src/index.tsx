/**
 * Small, dependency-light presentation primitives shared across BLINK screens.
 * Styling lives in the web app; these components only provide consistent
 * accessible markup.
 */
import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`blink-card ${className}`.trim()}>{children}</section>;
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  disabled = false,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type={type}
      className={`blink-btn blink-btn--${variant}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span className={`blink-pill blink-pill--${tone}`} role="status">
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'CONFIRMED':
      return 'ok';
    case 'WAITING_FOR_PAYMENT':
    case 'PAYMENT_INITIATED':
    case 'TRANSACTION_CREATED':
    case 'BROADCAST':
    case 'CONFIRMING':
      return 'warn';
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="blink-field">
      <span className="blink-field__label">{label}</span>
      {children}
      {hint ? <span className="blink-field__hint">{hint}</span> : null}
    </label>
  );
}

export function DataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="blink-row">
      <span className="blink-row__label">{label}</span>
      <span className="blink-row__value">{value}</span>
    </div>
  );
}

import Link from 'next/link';
import { Shell, TopBar } from '@/components/Shell';

const NETWORK = (process.env.NEXT_PUBLIC_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';

const ACTIONS = [
  {
    href: '/request',
    icon: '↓',
    title: 'Request',
    desc: 'Ask someone to pay you with a link',
  },
  {
    href: '/scan',
    icon: '↑',
    title: 'Pay',
    desc: 'Open a payment request and pay it',
  },
  {
    href: '/scan',
    icon: '▣',
    title: 'Scan',
    desc: 'Scan or paste a payment request',
  },
] as const;

export default function HomePage() {
  return (
    <Shell>
      <TopBar network={NETWORK} />

      <div className="stack">
        <div className="stack stack--sm">
          <p className="kicker">Private payments</p>
          <h1>
            Send money.
            <br />
            Not your wallet address.
          </h1>
          <p className="lede">
            BLINK turns a Zcash payment into a link. No addresses to copy, no jargon to learn.
          </p>
        </div>

        <nav className="actions" aria-label="Primary actions">
          {ACTIONS.map((action) => (
            <Link key={action.href} href={action.href} className="action">
              <span className="action__icon" aria-hidden="true">
                {action.icon}
              </span>
              <span>
                <span className="action__title">{action.title}</span>
                <span className="action__desc" style={{ display: 'block' }}>
                  {action.desc}
                </span>
              </span>
            </Link>
          ))}
        </nav>

        <div className="card">
          <h2>How it works</h2>
          <div className="row">
            <span className="row__label">1 · Create</span>
            <span className="row__value">Set an amount and a memo</span>
          </div>
          <div className="row">
            <span className="row__label">2 · Share</span>
            <span className="row__value">Send the link anywhere</span>
          </div>
          <div className="row">
            <span className="row__label">3 · Pay</span>
            <span className="row__value">Payer approves in their Zcash wallet</span>
          </div>
        </div>

        <p className="footer-note">
          BLINK is non-custodial. It never holds your funds or your keys.
        </p>
      </div>
    </Shell>
  );
}

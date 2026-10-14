import Link from 'next/link';

/** Repository, as the project publishes it. */
const REPO_URL = 'https://github.com/itzebe/blink-zcash';

/**
 * Site footer. Links point only at real routes in this application and the
 * public repository; there are no invented social accounts or contact details.
 */
export function SiteFooter() {
  return (
    <footer className="app-footer">
      <div className="app-footer__inner">
        <div className="app-footer__brand">
          <Link href="/" className="brand" aria-label="BLINK home">
            <span className="brand__mark" aria-hidden="true">
              B
            </span>
            BLINK
          </Link>
          <p>
            A non-custodial, shielded-first Zcash payment-request interface built on ZIP 321.
            BLINK never holds your funds or your keys.
          </p>
        </div>

        <nav className="app-footer__col" aria-label="Product">
          <p className="app-footer__title">Product</p>
          <Link className="app-footer__link" href="/checkout">
            Merchant checkout
          </Link>
          <Link className="app-footer__link" href="/request">
            Create a payment request
          </Link>
          <Link className="app-footer__link" href="/merchant">
            Merchant workspace
          </Link>
          <Link className="app-footer__link" href="/scan">
            Check a payment request
          </Link>
          <Link className="app-footer__link" href="/litepaper">
            Litepaper
          </Link>
        </nav>

        <nav className="app-footer__col" aria-label="Project">
          <p className="app-footer__title">Project</p>
          <a
            className="app-footer__link"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            Source code on GitHub
          </a>
          <a
            className="app-footer__link"
            href={`${REPO_URL}/blob/main/SECURITY.md`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Security model
          </a>
          <a
            className="app-footer__link"
            href={`${REPO_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noreferrer noopener"
          >
            MIT license
          </a>
        </nav>
      </div>
      <p className="app-footer__note">
        BLINK is an interface, not a custodian. It cannot move funds on your behalf and does not
        claim more privacy than the Zcash protocol provides.
      </p>
    </footer>
  );
}

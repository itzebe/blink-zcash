import type { Metadata } from 'next';
import Link from 'next/link';
import { AppFrame } from '@/components/Shell';

export const metadata: Metadata = {
  title: 'Litepaper',
  description:
    'The BLINK litepaper: a non-custodial, shielded-first Zcash payment-request interface built on ZIP 321, with an honest account of what privacy and verification can and cannot establish.',
  alternates: { canonical: '/litepaper' },
  openGraph: {
    type: 'article',
    title: 'BLINK Litepaper',
    description:
      'How BLINK turns a Zcash payment request into a shareable link, why it is shielded-first, and how far its transaction verification goes.',
    url: '/litepaper',
  },
};

const LAST_UPDATED = '14 October 2026';
const REPO_URL = 'https://github.com/itzebe/blink-zcash';

const SECTIONS: { id: string; title: string }[] = [
  { id: 'summary', title: 'Executive summary' },
  { id: 'problem', title: 'The problem' },
  { id: 'solution', title: 'The BLINK solution' },
  { id: 'architecture', title: 'Product architecture' },
  { id: 'how-it-works', title: 'How BLINK works' },
  { id: 'privacy', title: 'Shielded-first privacy model' },
  { id: 'verification', title: 'Verification and trust boundaries' },
  { id: 'security', title: 'Security and data handling' },
  { id: 'stack', title: 'Technology stack' },
  { id: 'use-cases', title: 'Use cases' },
  { id: 'limitations', title: 'Current limitations' },
  { id: 'roadmap', title: 'Roadmap' },
  { id: 'conclusion', title: 'Conclusion' },
  { id: 'resources', title: 'Project resources' },
];

export default function LitepaperPage() {
  return (
    <AppFrame>
      <article className="doc">
        <header className="doc__header">
          <p className="kicker">Litepaper</p>
          <h1>BLINK — private Zcash payment requests</h1>
          <p className="lede">
            A non-custodial interface that turns a Zcash payment into a simple, shareable link,
            takes a shielded-first approach to the recipient address, and is honest about what it
            can and cannot verify.
          </p>
          <p className="doc__meta">
            <span>Last updated: {LAST_UPDATED}</span>
            <span>Version 1.0</span>
            <span>License: MIT</span>
          </p>
        </header>

        <nav className="doc__toc" aria-label="Table of contents">
          <h2>Contents</h2>
          <ol>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        {/* 1 ------------------------------------------------------------- */}
        <section id="summary">
          <h2>1. Executive summary</h2>
          <p>
            BLINK is a web application for requesting Zcash payments. A recipient describes a
            payment — an amount, an optional memo, and an expiry — and BLINK turns it into a short
            link and a ZIP 321 payment request. The recipient shares the link. The payer opens it,
            reviews what the payment will do, and approves it inside their own Zcash wallet.
          </p>
          <p>
            BLINK holds no funds and no keys. It does not sign, broadcast, or move money. Its job is
            to make a payment request easy to create, easy to share, and honest about privacy. It
            builds every request in the ZIP 321 format, so a compatible wallet can read it directly
            and there is no proprietary payment scheme to trust.
          </p>
          <p>
            The product is shielded-first. BLINK refuses a recipient that can only be paid
            transparently, and it refuses a Unified Address that also exposes a transparent
            receiver, because a wallet could settle such a payment publicly on-chain. BLINK states
            the privacy of each request in plain language, and it does not claim that a shielded
            recipient address proves the payer used a shielded receiver.
          </p>
          <p>
            BLINK also keeps verification separate from payment. A transaction id supplied by a
            payer never confirms a payment. BLINK marks a request confirmed only after a configured
            provider observes the transaction on the Zcash network at the required depth. Where it
            cannot prove that the intended recipient received the exact amount, it says so instead
            of overstating what it knows.
          </p>
        </section>

        {/* 2 ------------------------------------------------------------- */}
        <section id="problem">
          <h2>2. The problem</h2>
          <p>
            Requesting a cryptocurrency payment is awkward in practice. Three problems recur.
          </p>
          <ul>
            <li>
              Communicating payment details is fiddly. A recipient has to send an address, an
              amount, and often a reference, and the payer has to copy each part without error. A
              wrong character can send funds to the wrong place.
            </li>
            <li>
              Sharing an address has a privacy cost. A raw wallet address is a permanent,
              reusable identifier. Once it is pasted into a chat, anyone who sees it can look up
              that address&apos;s activity on the public blockchain.
            </li>
            <li>
              Confirming payment is uncertain. After a payer says they have paid, the recipient
              has no easy way to tell whether the transaction is real, mined, and settled. A
              screenshot or a transaction id proves very little on its own.
            </li>
          </ul>
          <p>
            Payment-request standards already exist to solve the first problem. Zcash has ZIP 321,
            a standard way to encode a payment request in a single URI. General-purpose payment
            tools and wallets exist as well. BLINK does not claim to be the only way to request a
            Zcash payment. It focuses on a narrower goal: a request flow that is simple to share,
            shielded-first by default, and honest about the limits of verification.
          </p>
        </section>

        {/* 3 ------------------------------------------------------------- */}
        <section id="solution">
          <h2>3. The BLINK solution</h2>
          <p>
            BLINK turns a payment request into a link. The recipient sets the amount and an
            optional memo, and BLINK produces three things at once:
          </p>
          <ul>
            <li>A short link, such as <code>/pay/8K4Q2X</code>, that the recipient can share.</li>
            <li>A ZIP 321 payment request (a <code>zcash:</code> URI) with the amount and memo.</li>
            <li>A QR code that encodes that same payment request for a wallet to scan.</li>
          </ul>
          <p>
            The recipient address is encrypted at rest and never appears in the link. The link
            carries a short code, not an address. When a payer opens the link, BLINK resolves the
            short code to the payment request on the server, where it can check the network and
            verify a payment later.
          </p>
          <p>The primary flow has four properties:</p>
          <ul>
            <li>
              Recipient validation. Every address is parsed and classified. BLINK accepts Sapling
              addresses and shielded-only Unified Addresses. It rejects a transparent address, and
              it rejects a Unified Address that also carries a transparent receiver.
            </li>
            <li>
              Standard requests. Amounts and memos follow ZIP 321, so any compatible wallet can
              read the request. There is no custom payment format.
            </li>
            <li>
              Stated privacy. Each request shows, in plain language, what the route protects and
              what it exposes, derived from the address type.
            </li>
            <li>
              Honest status. A request has explicit states. It is confirmed only after an
              independent observation, never on the strength of a submitted transaction id.
            </li>
          </ul>
        </section>

        {/* 4 ------------------------------------------------------------- */}
        <section id="architecture">
          <h2>4. Product architecture</h2>
          <p>
            BLINK is a monorepo with four parts: a web application, an API, a Rust engine, and a
            database. The engine is authoritative for Zcash-specific work, and the API owns state.
          </p>

          <figure
            className="diagram"
            role="img"
            aria-label="Architecture: the web app calls the API; the API calls the Rust engine and PostgreSQL; the API observes the Zcash network through lightwalletd."
          >
            <div className="diagram__row">
              <div className="diagram__node diagram__node--brand">
                <div className="diagram__node-title">Web app</div>
                <div className="diagram__node-sub">Next.js, React</div>
              </div>
              <span className="diagram__arrow" aria-hidden="true">
                →
              </span>
              <div className="diagram__node">
                <div className="diagram__node-title">API</div>
                <div className="diagram__node-sub">Fastify, owns state</div>
              </div>
              <span className="diagram__arrow" aria-hidden="true">
                →
              </span>
              <div className="diagram__node">
                <div className="diagram__node-title">Zcash engine</div>
                <div className="diagram__node-sub">Rust, official crates</div>
              </div>
            </div>
            <div className="diagram__row" style={{ marginTop: 12 }}>
              <div className="diagram__node">
                <div className="diagram__node-title">PostgreSQL</div>
                <div className="diagram__node-sub">requests, events</div>
              </div>
              <div className="diagram__node">
                <div className="diagram__node-title">lightwalletd</div>
                <div className="diagram__node-sub">observe only, read-only</div>
              </div>
            </div>
            <figcaption>
              The web app talks only to the API. The API calls the Rust engine, stores state in
              PostgreSQL, and reads the Zcash network through a read-only lightwalletd connection.
            </figcaption>
          </figure>

          <h3>Web application</h3>
          <p>
            The Next.js client owns the experience: the homepage, the request form, the payer view,
            the confirmation and status screens, the receipt, and the scan screen. It renders the
            QR code and hands the payer to their wallet. It never handles keys, and it shows only
            blockchain state that the API reports.
          </p>

          <h3>API</h3>
          <p>
            The Fastify API owns request state. It creates and stores payment requests, keeps the
            recipient address encrypted at rest, assigns short codes, records events, and enforces
            the payment state machine. It is the only writer of blockchain-derived fields, and it
            does so only through the verification layer.
          </p>

          <h3>Zcash engine</h3>
          <p>
            The Rust engine is built on the official Zcash crates (<code>zip321</code>,{' '}
            <code>zcash_address</code>, <code>zcash_protocol</code>, <code>zcash_primitives</code>).
            It is authoritative for address inspection, ZIP 321 building and parsing, and
            transaction decoding. It is stateless: no keys, no database. The API defers to it so
            that address handling and URI construction follow the reference implementation rather
            than a reimplementation.
          </p>

          <h3>Database</h3>
          <p>
            PostgreSQL stores payment requests, their event history, and the transactions observed
            by the verification layer. The recipient address is stored encrypted; the memo is
            stored in plaintext.
          </p>
        </section>

        {/* 5 ------------------------------------------------------------- */}
        <section id="how-it-works">
          <h2>5. How BLINK works</h2>
          <p>
            BLINK separates four stages that are easy to confuse: creating a request, submitting a
            payment, confirming it on the blockchain, and verifying it. They are distinct in the
            product as well as in the protocol.
          </p>

          <figure
            className="diagram"
            role="img"
            aria-label="Payment flow: create a request, share the link, the payer pays, BLINK checks the evidence."
          >
            <div className="diagram__row">
              <div className="diagram__node diagram__node--brand">
                <div className="diagram__node-title">1. Create</div>
                <div className="diagram__node-sub">amount, memo, address</div>
              </div>
              <span className="diagram__arrow" aria-hidden="true">
                →
              </span>
              <div className="diagram__node">
                <div className="diagram__node-title">2. Share</div>
                <div className="diagram__node-sub">link or QR code</div>
              </div>
              <span className="diagram__arrow" aria-hidden="true">
                →
              </span>
              <div className="diagram__node">
                <div className="diagram__node-title">3. Payer pays</div>
                <div className="diagram__node-sub">in their own wallet</div>
              </div>
              <span className="diagram__arrow" aria-hidden="true">
                →
              </span>
              <div className="diagram__node">
                <div className="diagram__node-title">4. BLINK checks</div>
                <div className="diagram__node-sub">observes evidence</div>
              </div>
            </div>
            <figcaption>
              BLINK is involved in stages 1, 2 and 4. Stage 3 happens entirely inside the
              payer&apos;s wallet.
            </figcaption>
          </figure>

          <h3>Creating a request</h3>
          <p>
            The recipient enters an amount, an optional memo, and their Zcash address. BLINK parses
            the address, classifies it, and applies the shielded-first policy. If the address
            passes, the API asks the engine to build a ZIP 321 URI. The request is stored with the
            address encrypted, and the recipient receives a short link and a QR code.
          </p>

          <h3>Sharing and opening the link</h3>
          <p>
            Anyone with the link can open the payer view. It shows the amount, the memo, the
            recipient name, and a plain-language statement of what the route protects. Nothing is
            paid automatically. The payer chooses to continue.
          </p>

          <h3>Paying</h3>
          <p>
            When the payer continues, BLINK hands over the ZIP 321 payment request and the
            payer&apos;s wallet opens to approve it. BLINK does not construct, sign, or broadcast
            the transaction; the wallet does all three. If the wallet does not open, the payer can
            copy the payment request and paste it into a wallet manually.
          </p>

          <h3>Checking the evidence</h3>
          <p>
            After paying, the payer can give BLINK the transaction id so it can look the
            transaction up. BLINK records the claim and then asks the verification provider to
            observe the transaction. The request stays unconfirmed until a real observation
            happens. This is the stage where honesty matters most, and section 7 explains exactly
            what BLINK can establish.
          </p>
        </section>

        {/* 6 ------------------------------------------------------------- */}
        <section id="privacy">
          <h2>6. Shielded-first privacy model</h2>
          <p>
            Zcash has two kinds of address. A transparent address behaves like a public ledger
            entry: the address and the amount are visible to anyone. A shielded address uses
            zero-knowledge cryptography so the recipient and the amount are protected on the
            public blockchain. Sapling and Orchard are the two shielded pools BLINK supports.
            Sprout, the original shielded pool, is deliberately not supported.
          </p>
          <p>
            A Unified Address can contain several receivers at once: a shielded receiver, a
            transparent receiver, or both. This matters because a wallet is free to choose which
            receiver it pays.
          </p>

          <div className="doc__callout">
            <p>
              BLINK accepts a recipient only if its only receivers are shielded. It rejects a bare
              transparent address, and it rejects a Unified Address that also exposes a transparent
              receiver. The reason is simple: if a transparent receiver is present, a wallet could
              settle the payment there, and the recipient and amount would become public.
            </p>
          </div>

          <p>
            The policy fails closed. When the engine cannot report the receiver composition of an
            address, or an unrecognised receiver is present, BLINK does not hand the address out.
            An address BLINK cannot confirm as shielded-only is treated as unconfirmed, not as
            safe.
          </p>

          <h3>What this does not prove</h3>
          <p>
            A shielded-compatible recipient address does not, by itself, prove that the payer used
            a shielded receiver, and it does not make every aspect of the payment private. BLINK
            can confirm that the address you gave has shielded receivers, but it cannot control or
            see which receiver the payer&apos;s wallet chose. A payer who spends from a transparent
            address leaves that side public on-chain. BLINK states this on every request rather
            than implying the whole payment is private.
          </p>

          <h3>Two layers of privacy</h3>
          <p>BLINK separates two things that are easy to conflate:</p>
          <ul>
            <li>
              On-chain privacy. This is what the Zcash protocol protects for the route: a shielded
              recipient and amount, and, for a shielded payer, the sender.
            </li>
            <li>
              Application privacy. This is what BLINK itself handles. The recipient address is
              encrypted at rest and never appears in the share link. The memo, however, is stored,
              shown, and encoded in plaintext, because ZIP 321 memos are plaintext.
            </li>
          </ul>
          <p>
            BLINK never says a payment is anonymous, and it never claims that a transparent sender
            is hidden. If the payer spends from a transparent address, that side remains public
            on-chain even when the recipient is shielded.
          </p>

          <h3>What BLINK does not hide from the payer</h3>
          <p>
            Hiding the recipient from the payer is a different property, and BLINK does not claim
            it. A ZIP 321 request hands the recipient address to the payer&apos;s wallet, because the
            payer&apos;s wallet must know the destination to build the payment. Anyone who opens the
            payment link, or scans the QR code, can read the recipient address in the request — even
            though BLINK keeps that address out of the link itself, stores it encrypted at rest, and
            refuses any recipient that could settle transparently.
          </p>
          <p>
            BLINK therefore protects the recipient from <em>public</em> observers and from BLINK&apos;s own
            records, not from the payer. No standard Zcash payment protocol hides the destination
            from the party who authorizes the payment.
          </p>
        </section>

        {/* 7 ------------------------------------------------------------- */}
        <section id="verification">
          <h2>7. Transaction verification and trust boundaries</h2>
          <p>
            Verification is the part of a payment product that is easiest to overstate. BLINK keeps
            it deliberately narrow. It reports what an independent provider observed, and nothing
            more.
          </p>

          <h3>How an observation happens</h3>
          <p>
            The lightwalletd provider follows a fixed sequence, and any failure ends in no
            observation:
          </p>
          <ol>
            <li>
              It confirms it can reach a configured Zcash engine, which it needs to decode
              transactions.
            </li>
            <li>It confirms the endpoint is serving the same network BLINK is bound to.</li>
            <li>It fetches the transaction with the claimed id.</li>
            <li>
              It decodes the returned bytes with the engine and accepts the observation only if the
              decoded id matches the claim, so a payer cannot point BLINK at an unrelated
              transaction.
            </li>
            <li>
              It computes confirmations from the chain tip and the block the transaction was mined
              in.
            </li>
          </ol>
          <p>
            If any step fails, the provider returns nothing. The payment stays unconfirmed. BLINK
            never synthesizes a transaction and never fabricates confirmations.
          </p>

          <h3>What the verification states mean</h3>
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>What it means</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Observed</td>
                <td>
                  A mined transaction matching the claim was seen. Its pool composition could not
                  be decoded, or it is not yet at the required depth. No public contradiction was
                  found.
                </td>
              </tr>
              <tr>
                <td>Shielded activity observed</td>
                <td>
                  The transaction touches a shielded pool and does not pay the recipient&apos;s
                  transparent receiver. The shielded settlement is plausible. The recipient and
                  amount remain unprovable from public data.
                </td>
              </tr>
              <tr>
                <td>Shielded recipient verified</td>
                <td>
                  Only when the recipient has provisioned their Unified viewing key server-side:
                  BLINK trial-decrypted a shielded note in the transaction that pays the exact
                  requested address. The amount match is reported separately. The sender is never
                  identified. Without a key this state never arises.
                </td>
              </tr>
              <tr>
                <td>Recipient verified</td>
                <td>
                  The recipient exposes a transparent receiver and the transaction provably pays
                  it. This state never arises for a shielded-only recipient.
                </td>
              </tr>
              <tr>
                <td>Transparent settlement</td>
                <td>
                  The transaction touches no shielded pool, so the settlement is public. This
                  contradicts a shielded request and is never confirmed as shielded.
                </td>
              </tr>
              <tr>
                <td>Contradictory</td>
                <td>
                  The transaction pays the recipient&apos;s transparent receiver, contradicting the
                  shielded-only request.
                </td>
              </tr>
            </tbody>
          </table>

          <div className="doc__callout">
            <p>
              The honest boundary: for a shielded recipient, BLINK can observe that a transaction
              exists, is mined, and touches a shielded pool. Without the recipient&apos;s viewing
              key it cannot prove the intended recipient received the exact requested amount, and
              says so. With the recipient&apos;s viewing key provisioned server-side, it can
              additionally prove the exact recipient and amount by trial decryption — while still
              never identifying the sender.
            </p>
          </div>

          <p>
            BLINK treats a claimed transaction id as a claim, never as proof. The payer-supplied id
            is stored separately from the verified transaction, and only the verification layer
            writes the fields that a receipt relies on.
          </p>
        </section>

        {/* 8 ------------------------------------------------------------- */}
        <section id="security">
          <h2>8. Security and data handling</h2>
          <p>
            The controls below are implemented in the repository. BLINK does not claim an
            independent audit, formal verification, or regulatory approval.
          </p>
          <ul>
            <li>
              No keys, ever. BLINK never asks for a seed phrase or a private spending key, and it
              never stores one. It cannot sign or broadcast a transaction.
            </li>
            <li>
              Addresses encrypted at rest. A recipient address is encrypted with AES-256-GCM before
              it is stored, and it never appears in a public projection, a share link, or a
              receipt.
            </li>
            <li>
              No fabricated chain data. Transaction ids, confirmations, and confirmations-derived
              fields are written only by the verification layer, after a real observation. A
              payer&apos;s claim is kept apart from the verified transaction.
            </li>
            <li>
              Short codes from a CSPRNG. Short codes are generated from a cryptographically secure
              random source and are not sequential, so they cannot be guessed by enumeration.
            </li>
            <li>
              Network isolation. Mainnet and testnet addresses are rejected on a mismatch. Mainnet
              is opt-in and, in production, requires a configured verification provider.
            </li>
            <li>
              Standard formats only. Requests use ZIP 321. There is no custom payment URI format,
              and Sprout is rejected.
            </li>
            <li>
              Honest public projections. The public view of a request exposes the amount, memo,
              status, and privacy capability, but never the raw recipient address.
            </li>
          </ul>
          <p>
            One limitation is stated openly rather than hidden: memos are plaintext. BLINK stores,
            shows, and encodes the memo in the clear. Only the recipient address is encrypted at
            rest. BLINK never describes a memo as protected.
          </p>
          <p>
            A second disclosure is specific to the payer flow. To actually pay, a wallet needs the
            recipient address. BLINK therefore returns the full ZIP 321 payment URI — which
            contains the recipient address — from{' '}
            <code>/v1/payment-requests/&lt;shortCode&gt;/payment-details</code>. Anyone who
            possesses the short code can retrieve it. The share link itself never contains the
            address, but the short code is the access control, so a payment link should be treated
            as sensitive and shared only with the intended payer.
          </p>
        </section>

        {/* 9 ------------------------------------------------------------- */}
        <section id="stack">
          <h2>9. Technology stack</h2>
          <p>These are the frameworks and services the project uses today.</p>
          <table>
            <thead>
              <tr>
                <th>Component</th>
                <th>Technology</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Web application</td>
                <td>Next.js 15 with React 19, TypeScript</td>
              </tr>
              <tr>
                <td>API</td>
                <td>Fastify 5 on Node.js, TypeScript, Zod for validation</td>
              </tr>
              <tr>
                <td>Zcash engine</td>
                <td>
                  Rust with axum, built on the official crates: <code>zip321</code>,{' '}
                  <code>zcash_address</code>, <code>zcash_protocol</code>,{' '}
                  <code>zcash_primitives</code>, <code>zcash_transparent</code>
                </td>
              </tr>
              <tr>
                <td>Database</td>
                <td>PostgreSQL with Drizzle ORM</td>
              </tr>
              <tr>
                <td>Network access</td>
                <td>lightwalletd over gRPC, read-only, for verification only</td>
              </tr>
              <tr>
                <td>QR codes</td>
                <td>
                  The <code>qrcode</code> library to render, and <code>jsqr</code> to scan
                </td>
              </tr>
              <tr>
                <td>Tests</td>
                <td>Vitest for unit and integration tests, Playwright for end-to-end tests</td>
              </tr>
            </tbody>
          </table>
          <p>
            BLINK does not include a native token, a governance system, or a business model. It is
            an open-source, MIT-licensed interface.
          </p>
        </section>

        {/* 10 ------------------------------------------------------------ */}
        <section id="use-cases">
          <h2>10. Use cases</h2>
          <p>
            These are realistic applications of the current product. They are potential uses, not
            claims about existing adoption.
          </p>
          <ul>
            <li>
              Freelance payments and invoicing. Request an exact amount with a reference memo and
              share one link per invoice. The client pays without seeing the recipient address.
            </li>
            <li>
              Donations. Publish a request link so supporters can contribute without the address
              being pasted around, and without the recipient having to reuse one public address.
            </li>
            <li>
              Online commerce. A short-expiry request works as a checkout or point-of-sale charge,
              paid by scanning the QR code.
            </li>
            <li>
              Peer-to-peer requests. Ask for a specific amount over a messaging app, with the
              privacy of the route stated before anyone pays.
            </li>
          </ul>
        </section>

        {/* 11 ------------------------------------------------------------ */}
        <section id="limitations">
          <h2>11. Current limitations</h2>
          <p>
            BLINK discloses its limits rather than presenting itself as more mature than it is.
          </p>
          <ul>
            <li>
              Shielded verification cannot prove the recipient or the amount. For a shielded-only
              recipient, BLINK can observe that a transaction is mined and touches a shielded pool.
              It cannot prove from public data that the intended recipient received the exact
              requested amount.
            </li>
            <li>
              A shielded address does not force a shielded payment. A wallet may choose a
              transparent receiver when one is present. BLINK reduces that risk by refusing
              recipients with a transparent receiver, but it cannot see the payer&apos;s wallet.
            </li>
            <li>
              The sender side is outside BLINK&apos;s control. If the payer spends from a
              transparent address, that side is public on-chain.
            </li>
            <li>
              Memos are plaintext. BLINK stores and shows the memo in the clear. Only the recipient
              address is encrypted at rest.
            </li>
            <li>
              Verification depends on a configured provider. If no verification provider is
              configured, or the provider cannot observe a transaction, the payment stays
              unconfirmed. BLINK never substitutes a claim for an observation.
            </li>
            <li>
              Mainnet requires a real provider. In production, mainnet is bound to a configured
              verification provider and a configured price source; without them, the relevant
              features are disabled rather than faked.
            </li>
            <li>
              Requests expire. A request has a bounded lifetime. Once it expires, it is no longer
              payable.
            </li>
            <li>
              No independent audit yet. The security controls are implemented and tested in the
              repository, but the project has not undergone an independent security audit.
            </li>
          </ul>
        </section>

        {/* 12 ------------------------------------------------------------ */}
        <section id="roadmap">
          <h2>12. Roadmap</h2>
          <p>
            This separates what exists from what is proposed. Proposed items are not commitments,
            and none of them change how a payment settles.
          </p>
          <h3>Implemented</h3>
          <ul>
            <li>ZIP 321 payment-request creation, parsing, and QR encoding.</li>
            <li>Shielded-first recipient policy, with fail-closed receiver handling.</li>
            <li>Short links, a payer confirmation flow, and wallet handoff.</li>
            <li>Read-only verification through a lightwalletd provider, with honest states.</li>
            <li>Receipts, plain-language privacy disclosure, and network isolation.</li>
          </ul>
          <h3>Proposed</h3>
          <ul>
            <li>
              A testnet-verified, end-to-end shielded payment test with a funded wallet, to prove
              the full flow against real network data.
            </li>
            <li>Independent security review of the API and engine.</li>
            <li>Additional verification providers, behind the same honest states.</li>
          </ul>
        </section>

        {/* 13 ------------------------------------------------------------ */}
        <section id="conclusion">
          <h2>13. Conclusion</h2>
          <p>
            BLINK makes requesting a Zcash payment as simple as sharing a link. It builds every
            request in the ZIP 321 standard, keeps the recipient address out of the link, and takes
            a shielded-first approach by refusing recipients that could be paid publicly.
          </p>
          <p>
            Just as important is what BLINK does not do. It does not hold funds or keys, it does
            not sign or broadcast, and it does not claim more privacy or more verification than the
            network and its provider can support. A shielded recipient address is a good sign, not
            a proof, and BLINK says so.
          </p>
        </section>

        {/* 14 ------------------------------------------------------------ */}
        <section id="resources">
          <h2>14. Project resources</h2>
          <ul>
            <li>
              Source code:{' '}
              <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
                github.com/itzebe/blink-zcash
              </a>
            </li>
            <li>
              Security model:{' '}
              <a
                href={`${REPO_URL}/blob/main/SECURITY.md`}
                target="_blank"
                rel="noreferrer noopener"
              >
                SECURITY.md in the repository
              </a>
            </li>
            <li>
              Live application: <Link href="/">create a payment request</Link>
            </li>
            <li>
              Zcash protocol:{' '}
              <a href="https://zips.z.cash/zip-0321" target="_blank" rel="noreferrer noopener">
                ZIP 321 payment requests
              </a>
            </li>
            <li>
              Unified Addresses:{' '}
              <a href="https://zips.z.cash/zip-0316" target="_blank" rel="noreferrer noopener">
                ZIP 316
              </a>
            </li>
          </ul>
        </section>
      </article>
    </AppFrame>
  );
}

import React from 'react';
import Layout from '@theme/Layout';
import ScrollSpyNav, {
  type ScrollSpySection,
} from '@site/src/components/ScrollSpyNav';
import styles from './index.module.css';

const SECTIONS: ScrollSpySection[] = [
  {id: 'overview', label: 'Overview'},
  {id: 'authentication', label: 'Authentication'},
  {id: 'payments', label: 'Payments'},
  {id: 'webhooks', label: 'Webhooks'},
  {id: 'errors', label: 'Errors'},
  {id: 'sdks', label: 'SDKs'},
];

const SECTION_BODY: Record<string, string> = {
  overview:
    'ProxyPay is a payment proxy that bridges mobile-money rails and the Stellar network. This portal documents the public API surface.',
  authentication:
    'Requests are authenticated with a bearer token. Tokens are issued per merchant and scoped via RBAC. Rotate tokens regularly.',
  payments:
    'Create, capture, and refund payments. Each payment moves through a queue-backed state machine with idempotent retries.',
  webhooks:
    'Subscribe to lifecycle events. Webhook deliveries are signed; verify the signature before trusting the payload.',
  errors:
    'Errors use standard HTTP status codes with a machine-readable error code and a human-readable message in the body.',
  sdks:
    'Official SDKs are generated from the OpenAPI specification for TypeScript, Python, and Kotlin.',
};

export default function Home(): React.JSX.Element {
  return (
    <Layout
      title="Scroll-Spy Demo"
      description="Sticky navigation bar with active section highlighting"
    >
      <ScrollSpyNav sections={SECTIONS} ariaLabel="Page sections" />
      <main className={styles.main}>
        {SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className={styles.section}
            aria-labelledby={`${section.id}-heading`}
          >
            <h2 id={`${section.id}-heading`}>{section.label}</h2>
            <p>{SECTION_BODY[section.id]}</p>
            <p className={styles.filler}>
              Scroll through the page — the sticky bar above highlights the
              section currently in view. Click a link to smooth-scroll to it.
            </p>
          </section>
        ))}
      </main>
    </Layout>
  );
}

# ProxyPay Docs Portal

The ProxyPay developer documentation portal, built with
[Docusaurus 3](https://docusaurus.io/).

## Development

```bash
npm install
npm start        # local dev server at http://localhost:3000
npm run build    # static build into ./build (what CI deploys)
npm run serve    # preview the production build
```

CI builds this directory and deploys it to GitHub Pages — see
[`.github/workflows/api-docs-portal.yml`](../.github/workflows/api-docs-portal.yml).

## Sticky scroll-spy navigation

The home page demonstrates a sticky navigation bar with active-section
highlighting:

- **`src/components/ScrollSpyNav/`**
  - `index.tsx` — the sticky `<nav>` component (active highlight, smooth scroll,
    `aria-current`, reduced-motion aware).
  - `useScrollSpy.ts` — `IntersectionObserver`-based hook returning the id of the
    section currently in view (SSR-safe).
  - `styles.module.css` — sticky positioning and WCAG 2.1 AA color states.
- **`src/pages/index.tsx`** — demo page wiring the component to on-page sections.

### Reusing the component

```tsx
import ScrollSpyNav from '@site/src/components/ScrollSpyNav';

<ScrollSpyNav
  sections={[
    {id: 'overview', label: 'Overview'},
    {id: 'payments', label: 'Payments'},
  ]}
/>
```

Each `id` must match the `id` of a section element on the page. Give those
sections `scroll-margin-top` so smooth-scroll lands below the sticky bars.

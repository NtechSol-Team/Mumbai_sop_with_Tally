# Arthx ERP frontend

The product identity is the supplied Arthx wordmark followed by a separate ERP
label. The original artwork is copied intact to `apps/web/public/brand/arthx.png`.
The business's existing receipt artwork and legal policy content retain their
existing identities.

## Design system

- Midnight navigation (`#0c1933`) and cobalt primary actions, with white cards
  on a cool neutral work surface.
- Inter typography, restrained geometric backgrounds, consistent corner radii,
  subtle borders, tabular KPI figures and more readable table spacing.
- Existing green, amber and red status semantics remain distinct from branding.
- The shared class merge utility now recognises the project's font-size aliases.
  This prevents `text-label` and similar classes from dropping a button's text
  color. Seven regression checks cover sizes, colors and responsive overrides.

## Screens and interactions

- Sign-in: responsive split layout, logo, product introduction, existing login
  flow, associated validation errors, password visibility toggle and policy links.
- Navigation: existing module order and role filters, accessible active state,
  module search, collapsible desktop rail and a Radix mobile drawer with focus
  containment, Escape dismissal and focus return. Resizing to desktop closes it.
- Dashboard: business overview, existing KPIs and activity, role-filtered quick
  links, aligned KPI cards and a retry action for a failed overview request.
- Shared tables, header, cards and chart colors carry the palette across the ERP.
- Public page shell, page metadata and developer unlock screen use Arthx branding.
- Keyboard focus, skip-to-content navigation and reduced-motion preferences are
  supported. The sidebar/header are hidden for printing.

## Verification

TypeScript checks, all 26 production static pages, and the seven design-token
regression tests pass. Browser
review used an isolated copy and local fixture API; sample figures in screenshots
are not production figures. No production accounting records were written.

Reviewed desktop (1440 × 1000) and mobile (390 × 844): sign-in validation,
password visibility, successful login/logout, owner/admin navigation filtering,
module search, sidebar collapse, drawer focus/escape/resize behavior, dashboard,
and Tally ledger mapping tables. Checked for horizontal page overflow and error
overlays. An initial Tally preview error came from the fixture using `items`
instead of the real queue's `rows`; correcting the fixture restored rendering.

Screenshots and local-only fixture tools are in the untracked `artifacts/`
directory. Production uses the existing API endpoints and authentication flow.

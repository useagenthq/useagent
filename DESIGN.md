# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-09-01
- Primary product surfaces: session workspace, Agents rail, Settings providers,
  Apps/plugins, model picker, artifacts.
- Evidence reviewed: `frontend/styles/theme.css`, `frontend/app/globals.css`,
  `frontend/components/shell/theme-menu.tsx`,
  `frontend/components/chat/session-view.tsx`,
  `frontend/components/chat/agents-rail.tsx`,
  `frontend/app/settings/integration-connections.tsx`,
  `frontend/components/application/settings/settings-tools.tsx`, and
  `plans/ux_direction.md` in the product planning workspace, plus the provided
  26.35-second orchestration reference video (789 frames at 30 fps).

## Brand

- Personality: capable, quiet, technical, trustworthy, and result-oriented.
- Trust signals: exact provider/runtime state, durable receipts, visible
  provenance, honest degradation, and reversible controls.
- Avoid: decorative dashboards, exaggerated autonomy claims, fake availability,
  redundant badges, provider-specific product architecture, and dense raw logs
  as the default experience.

## Product goals

- Goals: let a user hand off work, understand what capabilities are available,
  connect missing services safely, follow parent/child execution, and receive a
  finished artifact or action. A parent thread must expose its child-session
  tree in both the session workspace and global thread sidebar, and an
  addressable child must accept a follow-up through the normal run-admission
  lane.
- Non-goals: clone full provider consoles, expose credentials/runtime bindings,
  make every provider operation look equivalent, or build a second scheduler,
  authorization system, transcript renderer, or artifact lane.
- Success signals: a user finds the right capability without knowing a tool
  name; unavailable actions explain why; connected-service permissions are
  understandable; child work is navigable without reading raw events.

## Personas and jobs

- Primary personas: technical individual, engineering/product team member,
  operations/research user, and self-hosting administrator.
- User jobs: delegate work, connect company systems, inspect progress, intervene
  safely, verify the result, and resume work through another supported harness.
- Key contexts of use: desktop web, long-running background runs, Slack-linked
  threads, and narrow/mobile observation.

## Information architecture

- Primary navigation: Threads, Customize, Apps, Artifacts, Settings.
- Core routes/screens: session workspace, Settings provider connections,
  capability/tools catalog, Apps/plugins, artifact workspace.
- Content hierarchy: user task and final result first; active parent/children
  second; details/provenance on selection; raw provider events last. The global
  thread list preserves the same parent/child hierarchy rather than flattening
  every child into an unrelated recent thread.

## Design principles

- One truth, several projections: UI, model discovery, settings, and docs consume
  the same backend capability/connection contracts.
- Capability-aware by default: controls are shown only when supported and return
  a typed unavailable reason if runtime truth changes.
- Preserve lane identity: gateway child runs and native provider children share
  one tree but remain visibly distinct.
- Addressability is explicit: product child runs are messageable across every
  harness; a provider task/native session becomes messageable only when a
  verified resume contract exists. Never turn an observed task ID into a chat
  target.
- Progressive orchestration: create named child placeholders immediately,
  stream status and counts into the same rows, and hydrate transcripts/results
  lazily without blocking the parent conversation.
- Progressive disclosure: compact summaries lead to one selected detail pane;
  avoid parallel inspector surfaces.
- Finished work is the product: capabilities and child activity support the
  deliverable rather than becoming the main visual focus.

## Visual language

- Color: semantic CSS variables from the existing light/dark theme system;
  blue for active/selected, green for verified success, red for failure, neutral
  surfaces for hierarchy.
- Typography: Inter for interface text and JetBrains Mono for identifiers,
  commands, models, and provider-native references.
- Spacing/layout rhythm: existing compact BoardUI/AlignUI density; 4/8/12/16px
  rhythm; no oversized hero cards inside the product.
- Shape/radius/elevation: reuse existing menu, panel, card, rail, and hairline
  border tokens; elevation only for overlays.
- Motion: restrained expand/collapse and selection transitions; status changes
  must remain readable with reduced motion.
- Imagery/iconography: existing Remix icons and provider/service marks; never
  use color alone to communicate status.

## Components

- Existing components to reuse: Settings rows/cards, integration connection
  list, model picker, Agents rail, `AgentDetail`, `SubagentsFold`, execution
  graph client, status chips, base dropdown/dialog/button components.
- New/changed components: capability catalog sections, connector permission
  summary, graph-backed child tree projector and nested node row, expandable
  thread-sidebar children, and a child-targeted composer for addressable nodes.
- Variants and states: declared, ready, degraded, unavailable, connected,
  pending, revoked, running, waiting, completed, failed, cancelled.
- Token/component ownership: frontend theme/base components remain authoritative;
  features may compose them but must not introduce a parallel token system.

## Accessibility

- Target standard: WCAG 2.2 AA.
- Keyboard/focus behavior: tree rows, expansion, selection, details, and actions
  are reachable in logical order with visible focus; no click-only controls.
- Contrast/readability: semantic tokens must pass in every shipped theme; status
  includes icon/text.
- Screen-reader semantics: use labelled sections, lists/tree semantics where
  appropriate, expanded/selected state, and descriptive unavailable reasons.
- Reduced motion and sensory considerations: respect reduced motion; no perpetual
  decorative loaders after terminal truth.

## Responsive behavior

- Supported breakpoints/devices: desktop-first from 1024px, usable observation
  down to 320px.
- Layout adaptations: desktop keeps the Agents rail/detail alongside the
  session; narrow layouts show the tree and detail as one drill-in surface.
- Touch/hover differences: every hover affordance has a persistent focus/touch
  equivalent; action targets meet minimum touch size.

## Interaction states

- Loading: one compact skeleton/status at the owning surface.
- Empty: explain what becomes visible after a connection, capability, or child
  exists; offer only the valid next action.
- Error: preserve existing data, identify the failed boundary, and offer a
  bounded retry when safe.
- Success: update the same row/node in place; do not create duplicate cards.
- Child creation: render the named child row as soon as admission succeeds;
  progress, task counts, artifacts, and terminal result fill that row in place.
- Child follow-up: the composer states which child session will receive the
  turn; submission creates a normal admitted run and never sends directly to a
  provider task identifier.
- Disabled: prefer hidden unsupported controls; when discoverability matters,
  show an explicit unavailable reason rather than an inert button.
- Offline/slow network: retain last durable snapshot, mark it stale, and avoid
  implying that a control was accepted until the backend confirms it.

## Content voice

- Tone: direct, calm, specific, and concise.
- Terminology: capability, tool, connected service, child run, native child,
  provider, model, verified, unverified, unavailable.
- Microcopy rules: explain the concrete reason and remedy; avoid “magic”, vague
  “something went wrong”, and provider implementation jargon when a product
  term exists.

## Implementation constraints

- Framework/styling system: Next.js 16, React 19, Tailwind 4, existing semantic
  theme tokens and base components.
- Design-token constraints: no hardcoded theme palettes or new token layer.
- Performance constraints: catalog payload is bounded/cacheable; child event
  transcripts load lazily; no eager full-history hydration. Based on the
  provided reference, orchestration acknowledgement should appear within 1s of
  admission, named child placeholders within 2s of the spawn receipt, and
  sidebar/tree updates should render on the next event without a page reload.
- Compatibility constraints: preserve existing API consumers, run admission,
  provider-session authority, gateway authorization, Slack/artifact semantics,
  and OSS/Pro shared boundaries.
- Test/screenshot expectations: pure projector/decoder tests, API contract tests,
  keyboard/semantic component tests, light/dark render checks, and one mixed
  native/gateway child end-to-end fixture. The release smoke must cover parent
  -> multiple named children -> nested sidebar -> child detail/transcript ->
  follow-up to an addressable child -> parent-visible result, across all four
  harnesses; unsupported native-child messaging must remain explicitly read-only.

## Open questions

- [ ] Which additional connector providers graduate into the curated catalog
  after GitHub, Slack, Gmail, Linear, Notion, and HubSpot? Owner: product.
- [ ] Which visual renderer/inspector profile becomes the first producer of
  artifact-quality attestations? Owner: artifacts/runtime.
- [ ] When provider APIs expose a portable close operation, extend the child
  control contract; until then close remains unavailable. Owner: runtime.

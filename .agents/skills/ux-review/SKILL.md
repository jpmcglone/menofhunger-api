---
name: ux-review
description: Audit web or iOS UI/UX, or compare Figma designs with implemented screens in both directions. Report evidence-backed gaps and recommendations; implement only when requested.
---

# UX Review

Follow the [engineering policy](../../../docs/engineering-policy.md), especially scope,
product decisions, Figma as the visual source of truth, and native platform behavior.
This skill supports a review; it does not authorize redesign, feature removal, or app changes.

Read [web.md](web.md) for web and [ios.md](ios.md) for iOS. Inspect only the references
and surfaces relevant to the requested review. Markdown links within this skill resolve
from the file containing the link. Resolve implementation paths from the relevant
repository root, discovered from the workspace and its `AGENTS.md`; do not assume the
agent’s current working directory or a fixed arrangement of sibling checkouts.

## Choose the review

- **UX audit:** identify problems that affect understanding, task completion, accessibility,
  feedback, or consistency. Use visual polish findings when they have concrete value.
- **Design comparison:** inventory the supplied Figma scope and compare it with the app in
  both directions. Distinguish missing behavior, visual differences, incomplete designs,
  and intentional native adaptations. Do not replace this request with a general redesign.
- **Focused review:** stay with the named screen, component, or journey. A full review covers
  the requested product scope; include admin when explicitly requested or present in an
  explicitly comprehensive design comparison. Otherwise report it as outside scope.

## Evidence and coverage

Record the Figma file/pages/components, app repositories or revisions, and running build
when identifiable. A component library is not a full screen specification. An icon asset
is not proof that its feature is implemented or even intended as a current feature.

Inspect the current source and walk the running product when available. The live app is
evidence of rendered behavior; source is evidence of the checked-out implementation.
If the running build is older or its revision is unknown, keep those conclusions separate.
Do not mark code absent just because a deployed build lacks it, or mark behavior working
just because a function exists. Do not start dev servers or rebuild solely to make a
read-only audit look more complete; report coverage limits and continue useful inspection.

For broad reviews, keep a compact coverage inventory rather than relying on a few example
screens. Check reusable masters and relevant instances, variants, themes, and breakpoints.
Distinguish **observed live**, **confirmed in source/design**, and **not verified**.
State which important states were not exercised; never imply an exhaustive runtime test.

## Preserve the product

Before recommending changes, inventory information, actions, permissions, state, and
navigation that the current implementation provides. Preserve useful behavior unless the
user authorizes its removal or evidence supports a specific change and replacement path.
Absence from a mockup is a design gap, not permission to delete the app feature.

Check applicable dimensions:

- Signed out, own profile/content, another member, organization/page, admin; membership
  tiers and permission gates. Distinguish hidden, disabled, locked, and unavailable states.
- Loading, empty, error/retry, offline/reconnect, submitting, success, stale/cached data.
- Long text, missing optional fields, media, Dynamic Type/zoom, small widths, light/dark.
- Active selections, combined filters, reset, drafts, unsaved changes, validation, and
  background work. A closed menu must communicate selections when they affect the result.
- Navigation/back behavior, deep links, keyboard/VoiceOver, full hit areas, and reduced motion.
- Realtime updates, optimistic changes and rollback, unread versus unseen, grouped actors
  versus event counts, and state preservation after navigation.

These are review dimensions, not a mandatory test matrix for every small task.

## Evaluate before prescribing

Prioritize task completion, information preservation, accessibility, and feedback over
cosmetic consistency. Ask whether controls communicate their purpose and current state,
navigation has a clear return path, and errors offer an appropriate next step.

Reuse the approved Figma language and existing semantic components/tokens. Respect native
navigation, keyboard, sheets, and interaction behavior. A native adaptation is not a defect
just because it is not pixel-identical to a web mockup; record material differences and
their rationale. Flag conflicts between Figma, guidance, and implementation explicitly.

Simplicity is a heuristic, not a quota. Do not automatically cut stats, tabs, secondary
actions, wrapped chips, inline composers, cards, or type levels. Recommend a change only
when their particular use causes a concrete problem. Likewise, do not impose fixed toolbar
counts, animation durations, word counts, skeletons instead of every spinner, or a new
palette. Keep needed actions discoverable; hover, swipe, and overflow are contextual tools.

For a proposed removal or demotion, state who uses it, what information or ability survives,
and where the user can find it afterward. If usage evidence is missing, say so. Do not
present personal taste as a usability failure or assume infrequent features are disposable.

## Two-way Figma comparison

Figma is the visual source of truth. When implementing it would lose existing useful
functionality or information, flag the design gap and update Figma before that migration.
Do not silently remove the capability or silently diverge from the design.

For each designed family or screen, record:

1. Figma link and relevant variants/states.
2. Web and iOS status separately: implemented, partial, missing, intentional adaptation,
   or not verified. Separate **asset exists**, **component exists**, and **wired into screen**.
3. Specific Figma-to-app differences, with source links or observations.
4. App information, behavior, or states absent from Figma that implementation must preserve.

Group repeated issues under shared components. List app areas with no Figma coverage
separately from gaps within designed screens. Do not turn every existing app feature into
an automatic request for new design work; identify what is needed for the proposed migration.
Do not copy sample counts, member details, credit prices, or other dynamic data literally.

## Report

Lead with the consequential findings and their impact. For each actionable finding include
the surface, concrete evidence, affected platform/state, proposed change, and preservation
requirements. Separate confirmed findings from hypotheses and untested behavior.

Use impact-based priorities such as blocking, important, or polish. **Remove**, **simplify**,
and **keep** describe recommendations, not severity. Scale structure and length to scope;
use a coverage table for comprehensive comparisons and concise prose for focused reviews.
Include implemented/working areas so the user can distinguish work remaining from work done.

An audit does not send messages, spend credits, submit forms, change membership, or mutate
user content merely to exercise a state. Use existing states or code evidence and explain
the untested boundary. When implementation is requested later, follow the repository's
validation matrix and verify the changed behavior against both the design and preservation inventory.

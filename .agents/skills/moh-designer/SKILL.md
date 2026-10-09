---
name: moh-designer
description: Design, polish, or review MOH web and iOS UI, including Figma comparisons, using shared tokens and native behavior.
---
# Men of Hunger design

Taste: Apple's clarity with Linear's useful density. Content over chrome; calm, scannable
rows; an obvious primary action. Improve the task, not compliance with a count of controls,
cards, type sizes, or animations. Preserve useful information and accessible actions.

Follow the [Figma-first workflow](../../../docs/engineering-policy.md#figma-is-the-visual-source-of-truth)
and [product policy](../../../docs/engineering-policy.md#product-and-visual-decisions).
Use [Figma guidelines](../../../docs/figma-guidelines/README.md) for library work and motion handoff.

## MOH visual language

Web tokens live in `assets/css/main.css`; iOS uses `AppTheme.swift` in its own checkout.
- Surfaces: `--moh-surface-0/1/2/3` / `Color.mohBackground`, `mohSurface1…3`.
- Text: `--moh-text`, `--moh-text-muted`, `--moh-text-soft` / `Color.mohText*`.
- Use `moh-divide` for web lists, `moh-border` for section chrome, and existing gutters.
- Inter for UI; Literata/`moh-serif` for quotes and daily prompts. Reuse semantic type roles.
- Brass indicates focus; membership, organization, and check-in colors retain their meaning.
- Reuse shared vector product icons; SF Symbols suit native system controls.

Feeds/settings use full-width rows rather than repetitive card wrappers. Marketing and detail
pages can breathe. Use shadows for actual elevation. For polish, check alignment, nested radii,
number stability, contrast, and press/focus/loading feedback. Prefer existing motion helpers;
respect reduced motion. Do not make hover the only route to an action.

Web keeps real links, keyboard/touch access, and back/filter state. iOS keeps SwiftUI navigation,
sheets, safe areas, and 44pt targets. Follow its local architecture and native-handoff guidance.
A native adaptation need not copy web pixels.

## Reviews and comparisons

A review produces findings unless edits were requested. Inspect source and available running
UI; distinguish observed behavior, source/design evidence, and unverified states. For broad
reviews, track coverage by screen and platform. Compare both directions: design gaps in the app,
and useful app behavior absent from a mockup. Preserve the latter during migration.
A component or icon existing in Figma does not prove a screen is implemented.

Inspect states relevant to the change: permissions/identity, empty/error/loading, long content,
keyboard/back navigation, themes, narrow widths/Dynamic Type, and realtime/optimistic updates.
Preserve drafts, composer actions, media, scheduling, and audience constraints during restyling.
Do not infer unread state from badge counts or confuse grouped actors with event counts.

Report impact, evidence, and a proposed fix; group repeated issues under shared components.
Explain intentional adaptations and coverage limits. Do not mutate real user content or launch
servers merely to complete a read-only audit. Use the [validation matrix](../../../docs/engineering-policy.md#validation-matrix)
for implemented changes.

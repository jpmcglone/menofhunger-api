# UX review — iOS

Read after [SKILL.md](SKILL.md). The implementation is SwiftUI in `menofhunger-ios`;
theme tokens live in `AppTheme.swift`. Inspect the current root navigation, sheet helpers,
and the iOS repository’s native-versus-web policy. Locate the `menofhunger-ios` workspace
root, read its `AGENTS.md`, and follow its native-versus-web rule entry (currently
`.cursor/rules/35-native-vs-web-handoff.mdc`, relative to that repository root). This rule
is readable by both Codex and Cursor; the folder name does not make it Cursor-only.
Do not resolve this path from the shared skill folder or assume sibling checkout locations.
If that repository is unavailable, report the policy as unverified and use the preservation
and handoff criteria below. Do not assume an older tab order or browser-handoff list still
describes the current app.

## Inspect the requested surfaces

Use the already-running Simulator or device when available. Record the installed build if
identifiable; an unknown or older build does not override current source findings. For a
broad daily-use audit, Home → post → profile → notifications → chat → search is a useful
order, followed by requested groups, check-ins, and secondary features. For Figma comparisons,
follow the designed inventory and distinguish mobile design intent from web-only layout.

Inspect relevant small-width, theme, keyboard, Dynamic Type, and VoiceOver states. Exercise
push/pop/back-swipe, tab return/reselect, and sheet dismissal where the task depends on them.
Report untested states; do not change system preferences or rebuild solely to satisfy a
universal checklist. Restore temporary inspection changes.

## Product-specific checks

- **Native ownership:** preserve SwiftUI navigation, tab/search behavior, safe areas, keyboard
  handling, and interactive dismissal. Use the project's existing routing and sheet helpers.
  A different placement for search or publish can be an intentional native adaptation, not
  an implementation failure. Explain how the designed capability remains available.
- **Icons and identity:** the approved Figma library and generated `MOHIcon` assets are the
  shared semantic source. SF Symbols remain appropriate for system-specific controls and
  native chrome. Do not reject custom shared icons simply because this is iOS. Check neutral
  defaults, selected states, tier/visibility color ownership, and organization avatar shape.
- **Layout:** content should remain readable and touchable under system chrome. Glass/material
  should express real layering; flag illegible or duplicated layers rather than declaring all
  custom chrome wrong. Do not automatically remove informative stats, wrapped utilities, or
  secondary actions to enforce a toolbar quota.
- **Touch and accessibility:** full-row actions need a content shape and the intended button
  style. Keep 44pt targets, useful VoiceOver labels/values/traits, logical grouping, text wrapping
  at accessibility sizes, contrast, and reduced-motion support. Long labels must not remove
  the primary action or overlap neighboring targets.
- **Profiles and permissions:** preserve own/visitor/page/organization/admin distinctions,
  follow relationships, messaging eligibility, notification subscriptions, status/nudges,
  optional metadata, gated feeds, and navigation to supporting details.
- **Composer:** preserve drafts and unsaved changes, keyboard shortcuts/edit menus, mention
  and entity completion, reply/edit/check-in/poll context, audience and group restrictions,
  media selection/paste/drop/alt text, upload progress/cancellation, and scheduling. Distinguish
  support for GIF files from an in-app searchable GIF picker. The emoji keyboard can be a
  native equivalent of an emoji button; do not label emoji entry missing without checking.
- **Feedback/data:** check loading, empty, retry, submitting, stale/cached, and reconnect states.
  Native progress and unavailable-content views may satisfy a Figma state without imitating
  the exact web skeleton. Preserve current information when a refresh fails. User-facing errors
  use `safeUserFacingMessage()`, not raw transport/decoding output.
- **Notifications:** unseen badge count and unread highlight remain separate. Preserve grouped
  distinct actors, actor/event identity, post previews, invitation actions, and destinations.
- **Realtime:** activation fetches and injected services should update the view without requiring
  a manual refresh. Check cleanup, optimistic rollback, account changes, and restored scroll/state
  where relevant; source wiring alone does not prove correct runtime behavior.
- **Handoffs:** classify a surface as native, intentional browser handoff, or unsupported using
  current policy and code. Check labeling, authentication, destination, and return path. A Figma
  button is not a promise that the linked destination is native. Flag missing core behavior
  separately from a designed and authorized browser handoff.

## Avoid false findings

Do not make iOS a pixel-for-pixel web port or declare all differences automatically justified
by the word “native.” Identify the specific adaptation and preserved capability. Likewise,
avoid categorical bans on inline composers, custom icons, typography, cards, or toolbars.
Recommend changes for demonstrated usability, accessibility, consistency, or design gaps.
Do not erase app information absent from a static mockup.

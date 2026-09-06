# UX review — web

Read after [SKILL.md](SKILL.md). The implementation is Nuxt/Vue/PrimeVue in
`menofhunger-www`; theme tokens live in `assets/css/main.css`. Inspect current navigation
and layout components rather than assuming a fixed tab or rail arrangement.

## Inspect the requested surfaces

Use the existing running app when available. For a broad daily-use audit, a useful route
order is Home → post → profile → notifications → chat → explore, followed by the requested
groups, check-ins, spaces, or secondary areas. For a Figma comparison, the Figma inventory
determines coverage. Include designed admin surfaces in a comprehensive comparison.

Inspect relevant desktop and narrow layouts, theme variants, keyboard behavior, and long
content. A 390px layout and a 320px/zoom check are useful probes when responsive behavior
matters, not a requirement to repeat every screen in every combination. Record omissions.
Avoid changing saved preferences merely for inspection; restore temporary viewport changes.

## Product-specific checks

- **Structure:** keep feeds edge-to-edge and use `moh-divide` for row separators. Check whether
  repeated headers obscure content; distinguish a useful sticky title from redundant chrome.
  Popover elevation and grouped cards can serve a purpose; do not ban shadows or cards outright.
- **Navigation:** internal navigation uses actual anchors/`NuxtLink` so cmd-click, middle-click,
  and open-in-new-tab work. Check full-row targets without nesting conflicting controls.
  Changing tabs or filters should preserve in-page state; back/forward and deep links should
  restore the intended context rather than resetting the feed.
- **Rows:** inspect the shared post, notification, and member families in their actual contexts.
  Preserve metadata and actions that support decisions. Long names, missing avatars, rich text,
  media, quotes, polls, and thread relationships must not cover or displace essential controls.
- **Selection:** verify sort and scope independently, including combined selections and reset.
  Keep state understandable when the menu is closed and without relying on color alone.
- **Actions:** primary actions should be easy to find; frequent secondary actions may remain
  visible. Hover enhances mouse use but cannot be the sole route for touch or keyboard users.
  Keep drafts, attachments/alt text, audience rules, scheduling, edit/reply context, validation,
  progress, error recovery, and optimistic behavior when restyling a composer.
- **Notifications:** badge count is unseen (`deliveredAt`); row highlight is unread (`readAt`).
  Grouped event counts and distinct actor counts are different. Preserve actionable invites,
  post-shaped notifications, safe system copy, and the correct destination for each event.
- **Data:** initial loading, empty, retry, stale, and reconnect states should be informative.
  Mutable server state fetches on activation and updates through existing realtime callbacks.
  Inspect user-facing behavior; do not claim it works solely from a subscription's presence.
- **Rendering:** inspect both SSR and hydrated behavior when relevant. Do not turn a review into
  an unsolicited full hydration/build test run; use the engineering validation matrix for edits.
- **Visual language:** use the current Figma library, semantic colors, typography, and generated
  shared SVGs. Check actual contrast, rather than assuming a token or a raw color is always safe.
  Literal example text, counts, and prices in Figma remain dynamic product data in the app.
- **Accessibility:** clear names for controls, visible focus, logical keyboard order, reachable
  menus, non-color state cues, appropriate headings, and reduced motion. Use the component's
  intended hit target (44px for shared compact controls), and verify adjacent targets do not overlap.
  At zoom/small widths, primary actions and information should remain reachable.

## Avoid false findings

Wrapped controls, more than two type sizes, inline composition, secondary navigation, and
informative stats are not defects by themselves. State the resulting usability problem.
Do not force native iOS chrome onto web or reduce desktop capabilities to match a narrow mockup.
For app functionality absent from Figma, recommend preserving it and documenting the necessary
states before migration; do not silently hide or delete it.

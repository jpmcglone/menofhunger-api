<!-- MoH guideline: 03-platforms-and-handoff.md; revision: 0190a98b7953970a97c9bc1cdafc2fefc94f797e43da99644c0eb66156b586d5; payload-sha256: 422edeb35c3e9587a5875ac2666465e53e853ced5a06c1b3de8621deba371662 -->
# Men of Hunger: platforms and handoff

Design in Men of Hunger — UI Library, then implement the approved direction in
iOS followed by web. Both Codex and Cursor use the same Figma frame links, repository
engineering policy, shared components, and these guidelines. Capture links to
masters, variants, screens, and motion timelines in the handoff.

iOS uses native SwiftUI navigation, search, sheets, focus, and keyboard behavior.
Use existing `.mohSheet` patterns and `router.push(...)`. Rows and controls have
full-width hit areas where appropriate and at least 44pt touch targets. Use shared
Figma product icons; system controls can use native icons when there is no library
equivalent. Support Dynamic Type and VoiceOver. Preserve system ownership of chrome.

Web uses Vue/Nuxt and existing CSS. Keep real links, browser navigation, keyboard
focus, and accessible menus. Hover actions must also be available to keyboard and
touch users. At desktop widths, use the lodge rail, content column, and inspector
with the same headers, filters, and row anatomy as a large iPad layout.

Inspect static design context, component structure, token bindings, and a screenshot.
If the interaction includes animation, also inspect its Motion timeline through
`get_motion_context` when available. Record trigger, states, properties, keyframes,
durations, easing, delays, interruption behavior, and reduced-motion alternative.
Missing Motion access or data is a handoff gap; do not invent values from a still image.

Verify compact and regular layouts, light and dark themes, loading/empty/error states,
keyboard/focus behavior, and reduced motion. Compare the actual clients against the
linked Figma states. Shared vector assets and semantic components should serve both
clients; native control behavior remains appropriate to each platform.

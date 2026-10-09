# Men of Hunger: motion and exploration

Motion communicates a user action or a meaningful state change. Keep it calm,
interruptible, and short enough that it does not delay input or completion. Build
reusable custom animation styles in the existing shared-interactions library.
The first authored pilot is enabled-button press feedback: scale to 0.96 over 120ms
with cubic-bezier(0.2, 0, 0, 1), then return to rest on release. With reduced motion,
use immediate opacity 0.7 and no scale. Disabled or busy controls keep their stable
state. Composer expansion, attachment appearance, and check-in completion are next
pattern candidates, not authored timelines; add them only within approved work.

Use the actual Figma Motion timeline and existing motion tokens. iOS uses native
SwiftUI and `MOHMotion`/`mohAnimation` helpers; web uses Vue transitions and existing
`--moh-duration-*`/`--moh-ease-*` CSS tokens. CSS motion output is a web reference,
not native SwiftUI code. Record any deliberate platform approximation in the handoff.
Do not guess timings, apply an arbitrary spring, or copy a web runtime into iOS.

Honor `accessibilityReduceMotion` on iOS and `prefers-reduced-motion` on web. Preserve
the final state and feedback without unnecessary scale, translation, springs, or
loops. Keep focus, hit targets, and semantics stable through transitions. Test
interruption and rapid repeated input. Avoid routine page-load choreography,
decorative bounce, and feed-wide animations on every realtime event.

Use Figma Make parallel chats and markup to explore alternative flows within the
agreed feature scope. Bring the chosen design back into the UI Library before
production implementation. Generated prototype code does not change our architecture,
frameworks, dependencies, permission model, or realtime contracts.

Use Weave and Motion for approved landing visuals, launch clips, and social assets.
Export Lottie only for supported illustrated animations where its runtime earns the
cost; ordinary app interactions use native SwiftUI or CSS. Audio and text animation
belong in an intentional media/marketing brief. Do not introduce audio autoplay,
external connectors, new dependencies, or product features merely because a tool
supports them. Stored or embedded generated media follows the repository media
ownership and review policy before shipping.

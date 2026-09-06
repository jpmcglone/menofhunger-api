# UX review — iOS

Read this after [SKILL.md](SKILL.md) when the platform is **iOS**. Do not apply web recommendations here.

Repo: `menofhunger-ios`. Theme: `AppTheme.swift`. Root chrome: `MainTabsScreen` — Home · Groups · Notifications · Chat, Search via `role: .search`. Sheets: `.mohSheet`.

iOS is not a web port. Native vs handoff is already decided (`35-native-vs-web-handoff`). Review native screens as native. Do not file "missing web feature" as a UX bug unless the user asked for parity.

## How to look

Walk the running app in Simulator (or device). A build is not a review. Exercise:

- Tab switch, tab reselect at root, tab reselect with a pushed stack
- Push / pop / interactive back-swipe
- Sheet drag past detent
- Search select vs search focus (iOS 26 morphology — don't fight it)
- Light and dark
- At least one larger Dynamic Type size
- Smallest current iPhone width

Skip admin unless asked. Skip web-handoff surfaces unless the handoff itself is the finding (dead end, unexpected Safari, missing auth).

## Walk order

### First-run

1. Login
2. Onboarding
3. Verification prompt (if it appears)

Look for: system-familiar forms, one question at a time, lodge voice, no web-card chrome.

### Daily loop

4. Home tab — feed, compose FAB, filters
5. Post detail — conversation, composer, overflow
6. Profile (from a row, then own profile via account drawer)
7. Notifications tab — unseen vs unread
8. Chat tab — inbox + thread
9. Search tab — discovery without stealing focus from ordinary navigation

### Lodge loop

10. Groups tab → group detail
11. Check-in surfaces
12. Bookmarks / settings from the account drawer

### Secondary native

13. Daily, fitness, premium, feedback — only if they are first-class screens
14. Anything that hops to web: is the hop intentional and labeled, or a surprise?

## What to look for

### System chrome (UI layer)

iOS 26: **UI layer vs content layer.** Tabs, toolbars, search, and glass belong to the system. Content scrolls underneath and carries the lodge.

- Stock `TabView` / `Tab(_:systemImage:value:)`. Custom tab labels, hand-swapped filled icons, or per-icon bounce fight Liquid Glass. Finding.
- Search uses `role: .search`. Do not force drawer placement to "move the field."
- Navigation title + toolbar: at most three toolbar items. The rest is a menu.
- Dual headers (large nav title *and* an in-screen H1 that repeats it). One.
- Glass on content rows, glass inside a scroll view, or glass on glass. Cut. Content is opaque lodge surface; chrome is glass.
- Brand color in the tab bar / toolbar. Move color into content (verified, premium, check-in meaning). Let glass pick up what's underneath.
- Safe area, home indicator, Dynamic Island: primary actions not trapped under the tab bar or the FAB.
- FAB / compose: one obvious compose path. It must not cover tab items, the last row, or the unread badge.

### Navigation

- Shared destinations go through `router.push`. Cross-tab jumps set `selectedTab` in the same move.
- Interactive pop works everywhere that pushed. A screen that traps the swipe is a Fix.
- Tab reselect: root scrolls to top / pops to root as the system teaches. Don't invent a third behavior.
- Deep links and notification taps land on the thing, with a back stack that makes sense.
- Account drawer vs settings: one place I manage *me*. Don't split identity across three mystery entries.

### Rows and lists

- Full-width row. `.contentShape(Rectangle())` after padding. `.buttonStyle(.plain)`.
- Hit target ≥ 44×44pt. The empty middle of an `HStack` must still tap.
- Two type levels. Semantic text styles + `Color.moh*`.
- SF Symbols, not a web icon set.
- Swipe actions for powerful secondary verbs if they exist; they must also live in an overflow menu (discoverability).
- Images: project loader, `scaledToFill`, clip, stable frame, placeholder, subtle neutral outline. Loading must not change row height.
- Avatars at full opacity. Don't dim the image container.

### Actions and composer

- One visible primary. Toolbar menu for the rest.
- Compose is a cover/sheet with a job, not a tiny inline editor fighting the feed.
- Safe acts unconfirmed. Destructive confirmed with a system alert, not a custom modal that looks like marketing.
- Optimistic: my post, my follow, my read-state update immediately.
- Sheets use `.mohSheet`. Short option sheets may `fitContent`. Editor / scrolling sheets must not. Drag past detent: no glass bleed.

### States

- `ScreenStateView` (or the shipped equivalent): loading, empty, error — not a blank `ProgressView` forever.
- Empty: one sentence + the action. No illustration kit.
- Errors: `safeUserFacingMessage()`. Never `localizedDescription`, decoding text, or type names.
- Pull-to-refresh may exist; it must not be the only way to see current data. Realtime still applies.
- Disabled / dimmed: the *control*, not the photo.

### Copy

- Lodge voice. Short. Imperative.
- System button titles where the system already has a word (Cancel, Delete, Done) — don't invent "Dismiss" next to system "Cancel."
- Nav titles: the screen's job, not the brand name on every push.
- Badge count = unseen (`deliveredAt`). Row highlight = unread (`readAt`). Swapping them is a Fix.

### Motion

- State-driven `withAnimation`. Spring ~0.3, damping 1.0. No bounce.
- Honor Reduce Motion — cross-fade instead of slide/scale when set.
- No page-load stagger on a feed the user opens every day.
- Interruptible. Don't lock the tab bar during a cute transition.

### Accessibility (iOS)

- Dynamic Type: largest accessibility sizes. Text wraps or truncates *on purpose*. Primary actions still exist.
- VoiceOver: every control has a name, a trait, and a value when the value matters. Don't leave "Button" or "Image."
- Don't use color alone for state.
- Increase Contrast / Reduce Transparency: lodge surfaces still separate from chrome. Glass must remain legible.
- Hit targets 44pt. Adjacent targets don't overlap.
- Smart Invert / dark mode: images and brass still read.

### Native-not-web

These are automatic findings if you see them:

- Web card chrome (rounded bordered page wrapper, KPI tiles, chip wrap).
- CSS density that ignores 44pt.
- Hover instructions ("hover to reveal").
- Custom fonts for UI chrome (system type only). Serif is a lodge moment, rare.
- Reimplemented tab bar, search bar, or back button.
- A screen that is both a list and an editor.

### Handoff

- If the path is web on purpose, the user should know they're leaving native (and come back cleanly).
- If the path is core (feed, post, profile, groups, notifications, bookmarks, auth, settings), "open this on the website" is a Cut/Fix — it didn't earn native yet or it is unfinished. Say which.

## Platform anti-recommendations

Do not suggest:

- Porting the web left rail, More sheet, or marketing sections into the tab bar.
- Custom glass, extra materials, or brand-tinted tab bars.
- Forcing search placement to match a mock.
- Replacing SwiftUI-owned delegates to "fix" tab behavior.
- Adding iPad/Mac patterns unless this review is explicitly for those idioms.
- Building native parity for admin, articles, or other secondary web surfaces unless the user scoped that.

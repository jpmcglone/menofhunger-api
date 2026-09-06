# UX review — web

Read this after [SKILL.md](SKILL.md) when the platform is **web**. Do not apply iOS recommendations here.

Repo: `menofhunger-www`. Tokens: `assets/css/main.css`. Nav model: `composables/useAppNav.ts`. Layout: `layouts/app.vue` (app) and `layouts/default.vue` (marketing).

## How to look

Walk the running app (assume the user has `npm run dev` up). Use the browser. Exercise the flow — don't screenshot one state.

Required viewports on every core surface:

- Desktop (~1280+): left rail + feed column.
- Phone (~390): tab bar + More. No hover.

Also check dark and light. Prefer borders over shadows.

Skip admin unless asked. Skip `/api/*` docs and Sentry example pages.

## Walk order

Do these in order. Stop and write findings as you go; don't batch a 40-screen memory pass.

### First-run (Apple density)

1. Marketing home `/`
2. Login `/login`
3. About `/about`
4. Tiers `/tiers` — only if the job of the review includes conversion

Look for: one idea per section, one CTA, no feature dump, lodge voice. This is not a dashboard.

### Daily loop (Linear density)

5. Home `/home` — feed, compose entry, filters/tabs
6. Post `/p/:id` — conversation, composer, overflow
7. Profile `/u/:username` — identity, feed, follow
8. Notifications `/notifications` — unseen vs unread
9. Chat `/chat` — inbox + thread
10. Explore `/explore` — search, discovery

### Lodge loop

11. Groups `/groups` → a group `/g/:slug`
12. Check-ins `/check-ins`
13. Spaces `/spaces` → a space `/spaces/:id`

### Secondary (demote, don't polish into primary)

14. Articles, bookmarks, crew, fitness, invite, scheduled, only-me, settings
15. Radio / daily / leaderboard — ask whether they earn a nav slot at all

On each, ask: would a stranger need this in the first week? If no, it should not compete with Home.

## What to look for

### Chrome and layout

- Dual headers (layout title bar + in-page header). One or the other. `hideTopBar` exists for a reason.
- Full-page `rounded-* border` wrappers. The page is the card. Edge to edge.
- Left rail vs mobile tab bar: same jobs, different presentation. Mobile gets 4 tabs + More — is More a junk drawer?
- Sticky title: quiet, hairline `moh-border`. Not a second product.
- Filter chips that wrap to two lines. Collapse or cut.
- Cards in cards, KPI tiles, stats rows above a list. Enterprise. Cut.

### Navigation and links

- Every navigation is a real `<a>` / `NuxtLink`. Right-click and cmd-click must work. Full-row cards use the overlay pattern (see `clickable-rows`).
- Buttons that only navigate are a finding. Buttons that mutate (Accept, Follow) may stay buttons.
- In-place tab/filter changes must not remount the page or blow scroll. URL can change; the list stays.
- Back/forward restores the list you were in, not a different feed offset.
- Deep links land on the thing, not a generic hub.

### Rows

- Full width. `moh-divide` only — never Tailwind `divide-y`.
- Two type levels: body + `moh-meta`. A third size is a finding.
- One tap target. Hover reveals secondary actions. Keyboard gets the same actions in a menu, not hover-only.
- Avatar + name · time + body + meta. Not a media-card collage.
- Status is a word or a small mark — not a badge pile, not a tinted row.
- Long content: clamp with intent, don't collide with actions.

### Actions and composer

- One visible primary: Post, Check in, Join, Save.
- Overflow / menu for the rest. Three equal buttons in a header is a finding.
- Safe acts (follow, bookmark, like) — no confirm. Destructive (leave, delete) — confirm.
- Optimistic update. Waiting for a refresh to see your own post is a Fix.
- Composer: obvious from Home. Don't hide the main verb behind a mystery icon if the screen's job is "say something."

### States

- Skeleton over spinner on first paint of a list.
- Empty: one sentence + the action that fills it. No illustration, no three tips, no carousel.
- Error: `getSafeUserErrorMessage` only. No fetch/HTTP/stack in the UI.
- Offline / reconnect: Connection banners should inform, not panic, not stack into a wall.
- Realtime: if another tab or user can change it, this page should patch in place. "I had to refresh" is a Fix.

### Copy

- Lodge voice: short, imperative, second person. See `config/voice.ts`.
- Labels are verbs: Post, Check in, Follow, Save.
- Copy that explains the UI ("Click the three dots to…") means the UI failed.
- Empty states and errors are product copy, not placeholders ("No results", "Something went wrong").
- Same act, same word, every surface.

### Motion and input

- 200–300ms, `cubic-bezier(0.2, 0, 0, 1)` or spring bounce `0`.
- Press `scale(0.96)`. No bounce, no confetti, no feed stagger on every visit.
- Hover is an enhancement. Phone users never see it — essential actions cannot live only there.
- Keyboard: Tab order matches reading order. Focus ring visible. Menus reachable without a pointer.
- Hit area ≥ 40×40px. Don't overlap hit areas.

### Visual system

- Only lodge tokens. New color = wrong problem.
- Serif / Literata only on quotes and daily prompts. Never chrome.
- Dark mode: borders, not drop shadows. Dividers still `moh-divide`.
- Images: subtle 1px black/white outline, not a tinted slate ring.
- Type roles: `moh-h1`, `moh-h2`, `moh-body`, `moh-meta`. A fourth size is a finding.
- Gutter: `moh-gutter-x`. Don't invent a third inset.
- Nested radii concentric if a nested surface actually exists. Prefer not nesting surfaces.

### Accessibility (web)

- Contrast on muted text, brass on dark, placeholder text, and hairline borders that carry meaning.
- Visible `:focus-visible`. Don't remove outlines without a replacement.
- Icon-only controls have an accessible name.
- Don't use color alone for verified / premium / check-in / unread.
- `prefers-reduced-motion` honored.
- Zoom to 200% and a 320px-wide window: no clipped primary action, no horizontal trap.
- If it looks like a heading, it is a heading. If it looks like a list, it is a list.

### Consistency sweep (web-specific)

- Home row vs profile row vs group feed row vs notification row — same family?
- Settings: rows, not cards. Grouped by job, not feature inventory.
- Marketing vs app: more air on marketing is correct. App pages that look like marketing are a finding. Marketing pages that look like a dashboard are a finding.

## Platform anti-recommendations

Do not suggest:

- Porting iOS tab order or Liquid Glass onto the website.
- A floating action button as the main compose path on desktop (rail/header already can hold Post).
- Hover-only essential actions.
- `window.alert` / unexplained toasts as error UX.
- New display fonts, gradients, or illustration libraries.
- Making More into a second product.

---
name: design-simplicity-principles
description: Core design and product principles for Men of Hunger — prioritize ruthlessly, ship simple, defend clarity. Use when designing or reviewing any user-facing feature, screen, component, API surface, or copy across web (Nuxt), iOS (SwiftUI), and API (NestJS). Triggers on UI design decisions, "should we add this", "feels cluttered", "feels overwhelming", "MVP scope", "feature creep", new screen/page/endpoint design, PRs that add buttons/options/fields/tabs/menus, review for polish, "what would Jobs do", grandma test, simplicity, less is more, and copy / microcopy choices.
---

# Design Simplicity Principles

Men of Hunger is an opinionated product. We win on clarity, not feature count. Apply these principles whenever you're proposing, building, or reviewing anything a user touches — a Vue component, a SwiftUI screen, an API response, a notification, a piece of copy.

## The two rules to remember

1. **The 10-second rule.** A new user decides in roughly ten seconds whether the screen they just opened is worth their attention. Every screen has a primary purpose. Make it obvious in the first second; let everything else fade behind it.
2. **What would we cut?** Before shipping, ask "what would I cut if I had to remove one thing?" — and then cut it. If you can't, the design isn't done yet.

## Core principles

### 1. Simplicity is harder than complexity

> "Simple can be harder than complex. You have to work hard to get your thinking clean to make it simple." — Steve Jobs

The first design that "works" is almost never the simplest one. Adding is easy; removing requires understanding. Budget time for the second pass where you take things away.

### 2. Simplicity is problem prevention, not decoration

A simple design isn't a design that looks minimal — it's a design that **solves problems before the user notices them.** A user who never has to ask "what does this button do" never has to be answered.

### 3. Affordances must be obvious (no PUSH/PULL doors)

The most common source of overwhelm isn't too many features — it's **ambiguous affordances.** Two icons that look the same but do different things. A button that looks like a label. A link that looks like a button. Always ask: "Could a stranger guess what this does without trying it?"

### 4. Less, but better

We will be tempted to add features because:
- Stakeholders ask for them
- Power users want everything
- Deadlines push us to "just ship it"

Resist all three. Every added option taxes every user forever. **The cost of a feature is paid every time someone scans the screen, not just on the day it ships.**

### 5. Saying "no" is part of the work

A "no" today is a gift to the user tomorrow. We are allowed — *required* — to push back on requests that don't earn their place. The phrasing that works:
- "What does this replace?"
- "Who specifically asked for this, and how often?"
- "What's the simpler version of this idea?"
- "Can this live one click deeper instead of on the main surface?"

### 6. Simplicity is invisible

Simplicity won't make people clap during a demo. Nobody screenshots a clean empty state. But simple products are the ones users **stay in, return to, and recommend.** Optimize for the long tail of trust, not the meeting reaction.

### 7. The grandma test

If a non-technical person can't accomplish the primary task on first try without asking — it isn't done. Doesn't matter how clever the implementation is.

### 8. Test, refine, repeat

The first version is a hypothesis, not a feature. Ship it, watch real people use it (or at minimum, walk through it cold yourself the next morning), and remove what didn't earn its place.

### 9. The emotional payoff

When a product just works, users feel three things — in this order:
1. **Grateful** that it didn't waste their time
2. **Confident** that they can use it again without re-learning
3. **Loyal** because both of the above are rare

This is the entire goal.

## Litmus tests (use before merging)

Ask these out loud about any user-facing change:

- [ ] **Primary purpose test:** Open the screen cold. Can you state its one job in five words or fewer?
- [ ] **What would I cut?** Pick the one element you'd remove if forced. Then remove it.
- [ ] **Grandma test:** Could a non-technical adult accomplish the primary task on first try, no tooltip required?
- [ ] **The 10-second test:** In ten seconds of first impression, is it obvious what to do next?
- [ ] **Affordance check:** Does every interactive element look interactive? Does every non-interactive element look non-interactive? No PUSH/PULL doors.
- [ ] **Empty / loading / error:** All three states are designed, not afterthoughts.
- [ ] **What would Jobs do?** Final gut-check before shipping.

## Engineering interpretations

How "less, but better" cashes out in each codebase:

### Web (`menofhunger-www`, Nuxt 3 + Tailwind)

- **Components:** prefer fewer props with smart defaults. A new prop must justify itself. If you're adding `variant="X" | "Y" | "Z"`, ask whether one of those should just be a separate component.
- **Pages:** one primary action per route. Secondary actions live in menus, not in the header.
- **Settings & toggles:** every toggle is a permanent UX tax — every user must wonder "is mine on or off?". Default it correctly and remove the toggle.
- **Copy:** prefer short, declarative labels (e.g. "Post" over "Submit your post"). Body copy uses `text-wrap: pretty`; headings use `text-wrap: balance`.
- **States:** every page must have designed empty, loading, and error states. Skeletons over spinners; specific empty-state messages over generic "No results."

### iOS (`menofhunger-ios`, SwiftUI / ESF View-First)

- **Screens:** one navigation goal per screen. If a screen has both a list *and* an editor, it should probably be two screens or a sheet.
- **Toolbars:** at most three items. Anything else moves into a menu.
- **Modifier soup:** if a view's modifier chain is longer than 8 lines, it's doing too much. Extract a small `View` rather than reaching for a `ViewModifier`.
- **Touch targets:** every tappable element ≥ 44×44pt. Don't make users aim.
- **System over custom:** SF Symbols, system colors, and standard navigation patterns build instant familiarity. Custom anything must justify the cost.
- **Animations:** `.spring(response:0.3, dampingFraction:1.0)` for state changes, never bouncy. Keep duration ≤ 0.3s.

### API (`menofhunger-api`, NestJS + Prisma)

- **Endpoints:** prefer adding fields to existing resources over multiplying endpoints. `GET /posts/:id` returning more is almost always better than introducing `GET /posts/:id/extras`.
- **Request bodies:** every optional field is a question the client must answer "what do I send here". Keep them rare and document defaults in the DTO.
- **Response envelopes:** the `{ data }` / `{ data, pagination }` / `{ meta }` contract IS our simplicity discipline — never invent a fourth shape.
- **Realtime payloads:** include only what the client needs to patch state, not the whole resource. The client already has the rest.
- **Errors:** specific, human-readable messages over codes. The error message is UX too — it's the only copy a user sees when things break.

## Common simplicity failures (and the fix)

| Failure | Fix |
| --- | --- |
| Two buttons that look identical but do different things | Make their visual hierarchy match their importance — primary, secondary, ghost |
| A "More" menu that exists only because we ran out of space | Cut the items that didn't earn the menu in the first place |
| A settings toggle nobody asked for | Pick a sane default, ship it, remove the toggle |
| Five tabs on a screen, four of which are rarely visited | One main view + a single "More" entry point |
| Copy that explains how the UI works | Redesign the UI so it explains itself |
| A new feature that mostly duplicates an existing one | Improve the existing one until the new feature is unnecessary |
| Notification spam ("we noticed you might…") | Send fewer, but every one earns its place |
| Form with 8 optional fields | One required field; everything else moves to a follow-up step or "Edit" |
| New endpoint added because changing the existing one was scary | Change the existing one (with a deprecation if it's public) — fewer endpoints is the win |

## When simplicity fights another principle

Simplicity is the tiebreaker when other principles are equal — not a license to ignore them. If accessibility, security, correctness, or accuracy require complexity, simplicity yields. The order is roughly:

1. Correctness
2. Accessibility & inclusion
3. Security & privacy
4. **Simplicity** ← default tiebreaker
5. Visual polish

When in doubt, ask: *"What would I cut?"* — and cut it.

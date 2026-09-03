---
name: moh-designer
description: Design Men of Hunger screens with Apple simplicity and Linear.app function. Use when designing or reviewing UI, layout, hierarchy, density, chrome, empty states, feed/list rows, navigation, or when the user mentions Apple, Linear, taste, visual design, "feels like a dashboard", "too sparse", "too busy", or "design this screen."
---

# Men of Hunger Designer

I like the simplicity of apple, but the function of linear.app

That is the taste. Apple decides what is on the screen. Linear decides how the work gets done.

## Where this sits

| Skill | Job |
|---|---|
| `design-simplicity-principles` | What to ship. Cut features. |
| **`moh-designer`** | How the screen works and looks. Hierarchy, density, chrome. |
| `make-interfaces-feel-better` | Pixel polish after the structure is right. Radius, motion, shadows. |
| `ux-review` | Full-platform UI/UX audit. Look, judge, recommend. Do not implement. |
| `moh-marketing` | Words outside the product. |

Do not redesign tokens. Do not invent a new aesthetic. Design inside the lodge.

## The synthesis

**Apple (simplicity)**
- One job per screen. Name it in five words.
- Content over chrome. The page is the card; do not wrap the route in a card.
- Progressive disclosure. Secondary actions live in a menu, hover, or one tap deeper.
- Familiar patterns. Do not invent a widget when a list, button, or system control will do.
- Hierarchy through type and weight, not a rainbow of color.
- Defaults so good a setting is unnecessary.
- A stranger understands the next action in ten seconds.

**Linear (function)**
- The list is the product. Rows are scannable, dense, and calm.
- Every pixel earns its keep. Sparse is not the same as simple.
- Metadata is information (name, time, status), not decoration.
- Primary action is always visible. Secondary actions appear on hover, press, or overflow.
- Speed is a design feature: optimistic updates, no dead clicks, no extra confirmation for safe acts.
- One quiet chrome. The row does the talking.
- Empty states start the next action. No illustrations. No pep talk.
- Status is a small color or a word — not a badge on every row.

**Not this**
- Consumer-social candy (gradients, stickers, confetti, bounce).
- Enterprise dashboard (cards in cards, KPI tiles, six filters).
- Bro-app chrome (oranges everywhere, shields, "level up").

## Lodge materials (use these, don't restyle)

Web tokens live in `menofhunger-www/assets/css/main.css`. iOS mirrors them in `AppTheme.swift`.

- Surfaces: `--moh-surface-0/1/2/3` / `Color.mohBackground`, `mohSurface1…3`
- Text: `--moh-text`, `--moh-text-muted`, `--moh-text-soft` / `Color.mohText*`
- Dividers: `moh-divide` on lists. `border-b moh-border` on section chrome. Never Tailwind `divide-y`.
- Type roles: `moh-h1`, `moh-h2`, `moh-body`, `moh-meta`. iOS: semantic text styles + `Color.moh*`.
- Gutter: `moh-gutter-x` / existing screen padding. Do not invent a third inset.
- Accent: brass for focus. Verified / Premium / check-in colors only for those meanings.
- Serif (`moh-serif` / Literata): lodge moments only — quotes, daily prompts. Never UI chrome.
- Font: Inter on web. System on iOS. Do not add a display face.

If you need a new color, you are solving the wrong problem.

## Screen recipe

1. **Name the job.** If you cannot say it in five words, split the screen.
2. **Cut chrome.** Title, one primary action, the list. Everything else is a candidate for removal.
3. **Make the row the unit.** Feed, notifications, members, settings: one tappable row, full width, `moh-divide`, metadata in `moh-meta`.
4. **One primary action.** Join, Check in, Post, Save. Not three equal buttons.
5. **Hide the rest.** Menus, hover, swipe, or a deeper screen.
6. **Design empty / loading / error** as first-class. Skeleton over spinner. Specific empty copy over "No results."
7. **Then polish** with `make-interfaces-feel-better` (concentric radii, tabular nums, 0.96 press, no bounce).

## Density rules

- **Lists:** Linear. Tight vertical rhythm, hairline dividers, two text levels max (body + meta).
- **Marketing / about / first-run:** Apple. More air, one idea per section, one CTA.
- **Settings:** Linear. Rows, not cards. Group by job, not by feature inventory.
- **Detail screens:** Apple structure (one column, one job) with Linear rows inside (replies, members, activity).

If a list feels empty, add information — not padding, not a card wrapper.
If a screen feels busy, remove a control — not the content.

## Platform

**Web**
- Edge-to-edge. No full-page `rounded-* border` wrapper.
- Real `<a>` / `NuxtLink` for navigation.
- Hover reveals row actions. Keyboard users get the same actions in a menu.
- Dark mode is first-class: borders, not shadows.

**iOS**
- System chrome first (`TabView`, nav bar, search, sheets via `.mohSheet`).
- SF Symbols. 44pt hit targets. `.contentShape(Rectangle())` on rows.
- Semantic type. `Color.moh*`. CSS-style padding shorthands.
- Do not port web card chrome onto iOS.

## Workflow

When asked to design or restyle a screen:

1. State the **job** in five words.
2. Show **what you would cut**.
3. Propose structure: chrome, primary action, row anatomy.
4. Implement with existing tokens and components.
5. If reviewing only, use the table below.

```markdown
**Job:** [five words]

| Cut | Why |
|---|---|
| [element] | [doesn't earn its place] |

| Keep / change | Why |
|---|---|
| [element] | [Apple simplicity or Linear function] |
```

Do not deliver moodboards, new palettes, or "inspiration" screenshots. Deliver the screen.

## Litmus

- Would Apple ship this much chrome? If no, cut.
- Would Linear make this row faster to scan? If no, densify or clarify metadata.
- Can a stranger do the one job in ten seconds?
- Did we add a color, card, or badge that isn't in the tokens? Revert it.
- What would we cut? Cut it.

Shipped patterns: [examples.md](examples.md)

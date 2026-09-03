---
name: ux-review
description: Full UI/UX review of one platform (web or iOS) using HIG, modern UX heuristics, and Men of Hunger taste. Use when asked to review UI/UX, audit screens, do a design review, or recommend UX changes. Look and recommend only — do not implement during the review.
---

# UX Review

Instructions for a full UI/UX review. **Look. Judge. Recommend. Do not implement.**

One platform per review. Web and iOS are different products that share taste, not one UI to port.

## Where this sits

| Skill | Job |
|---|---|
| `design-simplicity-principles` | What to ship. Cut features. |
| `moh-designer` | How a screen should work and look. |
| `make-interfaces-feel-better` | Pixel polish after structure is right. |
| **`ux-review`** | Walk a whole platform. Find what fails. Say what to change. |

Read the three skills above before judging anything. This file is the method. After you pick a platform, read that platform file:

- Web → [web.md](web.md)
- iOS → [ios.md](ios.md)

## Hard rules

1. **One platform.** If the user did not name one, ask. Do not "also glance at" the other.
2. **Review only.** No code, no restyles, no new components. Findings and recommendations only.
3. **Live UI beats source.** Walk the running product when you can. Code is evidence for *why*, not a substitute for *what it feels like*.
4. **Structure before polish.** A concentric radius on a screen with three jobs is the wrong finding.
5. **Cut before add.** If the fix is a new control, tab, badge, color, or setting, you have not finished thinking.
6. **Stay inside the lodge.** No new palette, typeface, card language, or "inspiration" aesthetic. Tokens already exist.
7. **Do not port platforms.** Never recommend a web card on iOS or an iOS tab pattern on desktop. Name the native pattern.

## Taste (do not renegotiate)

Apple decides what is on the screen. Linear decides how the work gets done.

- One job per screen, nameable in five words.
- Content over chrome. The page is the card.
- The list is the product. Rows are scannable, dense, and calm.
- One primary action. Everything else is menu, hover, swipe, or one tap deeper.
- Neutrals for structure. Brass for focus. Semantic color only for its meaning.
- No consumer-social candy. No enterprise dashboard. No bro-app chrome.

If a recommendation would fail the `moh-designer` litmus, rewrite the recommendation.

## The lens

Judge every surface through these. Name the one that failed when you write a finding.

**HIG (Apple)**

| Principle | Means here |
|---|---|
| Clarity | Legible type, precise icons, labels that remove doubt. "Post" not "Submit." |
| Deference | Chrome serves content. Dual headers, floating palettes, and card-in-card fail this. |
| Depth | Layers mean relationships: sheet over page, menu over row — not decorative blur. |
| Consistency | The pattern learned on Home works on Groups. Same row, same empty, same error. |
| Feedback | Every act answers. Press, save, fail, and "it's live" are visible. |
| Direct manipulation | Touch or click the thing, don't operate a remote control for it. Full-row targets. |

On iOS 26, also: **UI layer vs content layer.** System chrome (tabs, toolbars, search, glass) floats. Content scrolls underneath and carries the lodge. Do not put glass on content, and do not layer glass on glass.

**Modern UX (use these names, not a textbook dump)**

| Heuristic | Means here |
|---|---|
| System status | Loading, sending, live, offline — the user is never guessing. |
| Speak the user's language | Lodge voice. No product jargon on a first-run screen. |
| Control and freedom | Back, undo, dismiss. No trap doors. Confirm only destructive acts. |
| Error prevention | Defaults so good a setting is unnecessary. Don't ask, then reject. |
| Recognition over recall | Visible state and choices. Don't make them remember a hidden mode. |
| Flexibility | Power paths (keyboard, swipe, hover) may exist. The basic path must not need them. |
| Minimalist | Every control is a tax on every future scan. |
| Recover from errors | Specific, human, next-step. Never raw transport text. |

**MOH litmus (must pass)**

- Five-word job?
- What would we cut? Cut it.
- Grandma: primary task on first try, no tooltip.
- Ten seconds: obvious next action.
- Affordance: interactive looks interactive; static looks static. No PUSH/PULL doors.
- Empty / loading / error designed, not leftover.

Accessibility and correctness beat simplicity when they conflict. Simplicity beats polish.

## Method

Do the passes in this order. Do not start with pixels.

### 0. Lock scope

- Platform: `web` or `ios` — exactly one.
- Breadth: **full** (default when they say "full review") or **core loop** (Home → post → profile → notify) if they ask for a slice.
- Skip admin unless they ask. Admin is a different user.

Read the platform file. List the walk order. Then walk.

### 1. Inventory

For each surface: name, job in five words, core / secondary / experimental, first-run / daily / rare.

If you cannot name the job, that is already a finding.

### 2. Walk three users

Stay in character. Do not optimize for the person who built it.

| User | Question |
|---|---|
| **Stranger** | First 10 seconds. Can I tell what this is and what to do? |
| **Regular** | Daily loop (open, read, post, check in, reply, see a notification). Any extra tap, extra confirm, extra chrome? |
| **Edge** | Empty, error, offline, long content, large type, dark mode, smallest width. Does it hold? |

### 3. Passes

On every surface you walk, run these. Stop a pass when the structure is wrong — don't polish a screen you would split.

1. **Job and chrome** — one job, one title, one primary action. Dual headers? Stats row? Three equal CTAs? Cut.
2. **Wayfinding** — where am I, how did I get here, how do I leave, can I open this in a new tab / pop the stack?
3. **Rows and lists** — the unit of the product. Full-width, two type levels, metadata that informs, actions on hover/menu/swipe — not a button pile.
4. **Actions and forms** — primary visible; secondary hidden; safe acts unconfirmed; destructive confirmed; composer obvious.
5. **States** — skeleton over spinner; empty that starts the next act; error with a next step; live data without a refresh.
6. **Copy** — short, imperative, second person. Labels that do the verb. No copy that explains the UI.
7. **Motion and feedback** — 200–300ms, no bounce, interruptible. Press scale. Toasts for confirmation, not for chatter.
8. **Accessibility** — contrast, hit targets, focus/VoiceOver, Dynamic Type / zoom, reduced motion, labels that name the thing.
9. **Consistency** — same entity, same anatomy, same words, across the platform.
10. **Polish last** — concentric radii, optical alignment, tabular nums, image outlines. Only if 1–9 are clean.

### 4. Cross-surface sweep

After the walk, look across screens — not at one more screen.

- Same row used for posts / notifications / members / settings? If not, why.
- Same words for the same act (`Post`, `Check in`, `Follow`).
- Badge = unseen. Highlight = unread. Never swapped.
- Dark and light both intentional.
- Nav count: is everything in primary nav earning a permanent slot?

## How to recommend

A recommendation is a decision, not a vibe.

### Severity

| Severity | Use when | Typical action |
|---|---|---|
| **Cut** | It does not earn its place. Extra chrome, extra tab, extra setting, duplicate path. | Remove or demote one tap deeper. |
| **Fix** | Users will fail, guess, or get stuck. Broken affordance, a11y miss, HIG/platform violation, wrong job. | Specific structural change. |
| **Simplify** | It works, but it asks too much. Too many actions, modes, or words. | Collapse, hide, default. |
| **Polish** | Structure is right; the detail is sloppy. | Token-legal visual/motion fix. |
| **Keep** | You looked and it earns its place. | Say so. Silence is not a pass. |

Prefer fewer findings. A review that files 40 polishes and misses a dual header has failed.

Order the write-up: Cuts and Fixes first. Simplifies next. Polishes last. Keeps in a short list, not a speech.

### Quality bar for each finding

Every finding must have all of these. If you cannot fill them, you do not have a finding yet.

1. **Surface** — screen / route / component a human can open.
2. **Job** — five words.
3. **Saw** — what is on the screen. Concrete. Not "feels cluttered."
4. **Fails** — one named principle from the lens.
5. **Change** — the specific thing to do. Name the element to remove, move, or replace. Name the pattern to use (`moh-divide` row, system toolbar, overflow menu).
6. **Not this** — the redesign to refuse (new color, extra card, web pattern on iOS, a setting).
7. **Severity** — from the table.

Do not recommend:

- A new aesthetic, palette, display face, or illustration system.
- A new feature, mode, tab, or setting unless it *replaces* something you are cutting.
- Parity with the other platform as a goal.
- Pixel tweaks on a screen whose job is unclear.
- "Add onboarding," "add a tooltip," or "add empty-state art" to paper over a bad affordance.
- Confirmations for safe acts. Toasts for things the list already shows.

Do recommend:

- Cuts, with what the user does instead.
- One primary action, and where the rest go.
- The existing component or system control that should be used.
- Copy in lodge voice when the current string is the problem.
- Demotion: secondary surfaces out of primary nav, into More / menu / handoff.

### Finding template

```markdown
### [Severity] [Surface] — [five-word job]

**Saw:** [exactly what's on screen]
**Fails:** [principle]
**Change:** [the one thing to do]
**Not this:** [the tempting wrong fix]
```

## Output

Write the review as a standalone markdown the user can file. No moodboards. No screenshots-as-argument unless they prove a specific saw.

```markdown
# UX review — [web | iOS]

**Scope:** [full | core loop | named surfaces]
**Walked as:** stranger, regular, edge
**Not reviewed:** [admin, marketing, handoff, …]

## Verdict

[8–12 sentences. What the platform is doing well. The one or two problems that matter most. What we would cut first.]

## Cuts and fixes

[finding blocks, worst first]

## Simplifies

[finding blocks]

## Polishes

[finding blocks — omit if structure is still wrong]

## Keeps

- [Surface]: [why it earns its place]
- [Surface]: [why]

## Suggested order

1. [first change — usually a cut]
2. [second]
3. [third]
```

End with the suggested order. Three to seven items. That is the review's actual output. The rest is evidence.

## If you get stuck

- You want to add a control → what would we cut instead?
- You want a new pattern → which shipped pattern in `moh-designer/examples.md` already covers this?
- You want parity → is this core native, secondary handoff, or experimental?
- You only have code → say what you could not walk in the live UI.
- The screen is both a list and an editor → recommend a split or a sheet, don't polish the hybrid.

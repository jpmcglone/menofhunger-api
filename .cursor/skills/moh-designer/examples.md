# Designer patterns

Concrete do / don't. Match these, don't restyle them.

## Rows (Linear)

**Do:** full-width row, avatar + body + meta, `moh-divide`, one tap target, actions on hover/menu.

```
[avatar]  Name · time
          Body line, two if needed
          meta · meta                         [overflow]
```

**Don't:** card-per-row, colored left rails, stacked action buttons, badge piles.

## Screens (Apple)

**Do:** title (or system bar) + one primary action + the list.

```
Check in today                    [Check in]
--------------------------------
row
row
row
```

**Don't:** hero banner + stats row + three CTAs + filters + the list.

## Empty

**Do:** one sentence + the action that fills it.
"Your feed is waiting. Find men worth following."

**Don't:** illustration, three tips, a carousel of features.

## Color

**Do:** neutrals for structure. Brass for focus. Verified blue / Premium brass / check-in green only when that is the meaning.

**Don't:** tint a whole row green because it's a check-in. A small mark is enough.

## Type

**Do:** `moh-h1` for the screen job, `moh-body` for content, `moh-meta` for time/status. Serif only on a prompt or quote.

**Don't:** a fourth size, a gradient fill on a heading, all-caps section labels everywhere.

## Chrome

**Do:** frosted sticky title if the list scrolls. Hairline `moh-border`. Quiet.

**Don't:** dual headers (layout title bar + in-page header). Floating tool palettes. Filter chips that wrap to two lines.

## Motion

**Do:** 200–300ms, `cubic-bezier(0.2, 0, 0, 1)` or spring with bounce `0`. Interruptible.

**Don't:** bounce, confetti, page-load stagger on a feed the user sees every day.

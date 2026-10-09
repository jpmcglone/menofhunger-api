<!-- MoH guideline: 02-materials-and-tokens.md; revision: 2822892c20072b132855fa195b91dc10c1548312b81f04e366cc6b0cd26cbf65; payload-sha256: de46519cc28d4669b9bb0c896c34f274a01d686a29093cb6ec02e7d6be7147f2 -->
# Men of Hunger: materials and tokens

Bind designs to the library's semantic light/dark variables. Inspect the selected
component's bindings instead of substituting raw colors or introducing a new palette.

| Role | Web implementation | iOS implementation |
| --- | --- | --- |
| Page background | `--moh-surface-0` | `Color.mohBackground` |
| Primary surface | `--moh-surface-1` | `Color.mohSurface1` |
| Elevated surface | `--moh-surface-2` | `Color.mohSurface2` |
| Popover/dialog surface | `--moh-surface-3` | `Color.mohSurface3` |
| Body, metadata, tertiary text | `--moh-text`, `--moh-text-muted`, `--moh-text-soft` | `Color.mohText`, `mohTextMuted`, `mohTextSoft` |
| Separation | `--moh-border*`, `moh-divide` | `Color.mohBorder*` |
| Focus/interactive accent | `--moh-brass` | `Color.mohBrass` |

Use Inter for UI. Literata/serif is for lodge moments such as quotes and daily
prompts, not toolbar labels. Use semantic heading/body/meta roles and the existing
screen gutters. Hierarchy comes from type, weight, and spacing before accent color.

Verified, Premium, check-in, presence, action, and Marv colors retain their existing
meanings. Do not use a status color as decoration or make ordinary users look verified.
Keep sufficient contrast in both themes. Dividers separate adjacent content; shadows
express real elevation. A shadow is not a universal replacement for a border.

The implementation token sources are web `assets/css/main.css` and iOS
`Packages/MOHCore/Sources/MOHCore/DesignSystem/Theme/AppTheme.swift`. Reuse a semantic
token first; add one only for a needed state or accessible distinction and maintain
it across themes and platforms. Report a binding mismatch rather than guessing.

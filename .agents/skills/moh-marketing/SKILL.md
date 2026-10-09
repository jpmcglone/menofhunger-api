---
name: moh-marketing
description: Write MOH marketing, invitations, email, App Store, and product copy in the existing voice, using current product facts.
---
# Men of Hunger copy

Grounded, competent, welcoming. Discipline and service without macho/alpha bait, hype,
feature dumps, or motivational-poster language. Short, concrete copy with a clear next step.
Use the requested format; do not force three variants, seven-day campaigns, or strategy essays.

## Voice and facts

Find these in the web checkout when their facts are relevant:
- `config/voice.ts`, `config/site.ts`: canonical wording, identity, URLs.
- `pages/about.vue`, `pages/comparison.vue`, `pages/index.vue`: positioning and current landing copy.
- `config/tiers.data.json`: current prices and shipped benefits.
- `composables/useInviteReward.ts`, `utils/acquisition-share.ts`: invitation/share language.
Verify reward eligibility/timing against API billing/referral behavior; historical examples can
be stale. For emails, consult API `docs/email-lifecycle.md` and `docs/email-delivery.md`.

The established frame is the lodge: trusted conversation and accountability for men, rather
than a noisy town square. Tagline: “A trusted community for men who want real conversation,
not more noise.” Promise: “Show up. Say something real. Help the men beside you rise.”
Sign-off when appropriate: “Stay tuned. Stay hungry.”

Identity verification is free; paid membership supports the product rather than buying reach.
Check current entitlements before listing unlocks; never advertise planned features as shipped.
Lead with the action appropriate to the task: join, verify, participate, invite, or upgrade.
For email, use a clear subject, concise body, and one useful primary action; honor preferences.
Product edits belong in the owning strings/templates, not a parallel copy document.
Drafting copy does not authorize sending it.

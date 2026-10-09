# Figma library guidelines

The numbered Markdown files here are canonical in the API repository. Their content
is derived from the engineering policy and shared design skills. Do not edit mirrored
copies or the generated export. Both Codex and Cursor read the same repository policy
and can use this bundle in Men of Hunger — UI Library.

## Connected editors

Verified on October 9, 2026: Codex's Figma account lookup succeeded. Cursor's
Customize → MCPs panel shows Figma Connected with a green status indicator,
41 tools, and 120 resources enabled. Both editors use the official Figma connection
and this shared repository workflow; keep vendor skills in their installed plugin.
Tool availability can change, so inspect the current catalog when using Motion.

## Update and apply

From the API repository:

```sh
python3 scripts/sync-figma-guidelines.py
python3 scripts/sync-figma-guidelines.py --check --local-only
```

The script creates four numbered `export/*.md` files for Figma and a deterministic SHA-256
`export/manifest.json`. It tracks the numbered files, engineering policy, and shared
design skills. A change in those sources changes the export revision, so a previously
applied bundle no longer passes `--check` until it is reviewed and applied again.

Upload or replace the four exported Markdown files through the library's supported guidelines
interface. Publishing or attaching it must be reported separately from export creation.
If Figma offers a download, download the actual files into a temporary directory. Then run:

```sh
python3 scripts/sync-figma-guidelines.py --record-applied \
  --readback /tmp/moh-figma-guidelines-readback \
  --figma-url https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN
python3 scripts/sync-figma-guidelines.py --check
python3 scripts/sync-agent-guidance.py
python3 scripts/sync-agent-guidance.py --check
```

Use `--ios-root /absolute/path/to/menofhunger-ios` on the shared-guidance command when
the active iOS checkout is a worktree. The sync command mirrors this directory and
the shared policy/skills to web and iOS; it does not access Figma.

When the UI has no download control but provides a file preview, open each uploaded file and inspect its
first line. Record those visible headers and the actual Apply changes confirmation
in a temporary JSON file using this structure:

```json
{
  "headers": {
    "01-product-and-components.md": "<actual displayed first line>",
    "02-materials-and-tokens.md": "<actual displayed first line>",
    "03-platforms-and-handoff.md": "<actual displayed first line>",
    "04-motion-and-exploration.md": "<actual displayed first line>"
  },
  "apply_confirmation": "<observed confirmation/state after Apply changes>"
}
```

Run `--record-applied --ui-evidence /tmp/figma-ui-evidence.json --figma-url <library-url>`.
The script checks all visible revision/hash headers but cannot verify the remaining
remote bytes through this method. Never generate evidence from local headers alone;
the operator or agent must inspect the actual uploaded files and applied UI state.

The current library UI may offer only Rename, Replace, and Delete. In that case,
record the actual local files selected for upload, the filenames displayed after
upload, and the observed Apply confirmation. Do not claim a remote header readback.
Use a temporary JSON file with this structure (include all four files):

```json
{
  "uploaded_files": {
    "01-product-and-components.md": "/absolute/path/to/export/01-product-and-components.md",
    "02-materials-and-tokens.md": "/absolute/path/to/export/02-materials-and-tokens.md",
    "03-platforms-and-handoff.md": "/absolute/path/to/export/03-platforms-and-handoff.md",
    "04-motion-and-exploration.md": "/absolute/path/to/export/04-motion-and-exploration.md"
  },
  "observed_filenames": [
    "01-product-and-components.md",
    "02-materials-and-tokens.md",
    "03-platforms-and-handoff.md",
    "04-motion-and-exploration.md"
  ],
  "apply_confirmation": "Changes applied. The agent will use your updated files."
}
```

Run `--record-applied --upload-evidence /tmp/figma-upload-evidence.json --figma-url <library-url>`.
This hashes the actual files used and records the observed application. It does not
verify remote contents or later edits. Never produce this receipt before actually
uploading these files and observing the confirmation. The UI was verified on October
9, 2026 to list all four filenames, 9KB total (8,187 bytes), and that confirmation.

`applied.json` is created only after the supplied evidence matches the export.
It records the library URL, manifest hash, verification method, and UTC verification time.
`--check` fails when the local bundle or last verified application is stale or absent.
The ordinary `scripts/sync-agent-guidance.py --check` validates the local export only.
Use the separate Figma check when applying guidelines; an unrelated guidance edit does not
require a remote upload. The original receipt stays historical until a real application is verified.
It cannot detect a later remote edit without a fresh readback. For that check, download
the current files and pass `--check --readback /tmp/current-guidelines`, or pass fresh
`--ui-evidence` with its explicitly limited verification scope.
An export or receipt is never evidence that an unsupported remote API succeeded.

## Current motion pilot

[Action feedback specimen](https://www.figma.com/design/YnuRSJB7p90n9jEY4mb4RN?node-id=1387-48861)
contains linked button instances in light/dark, standard/reduced motion, and disabled states.
Press and release each use 120ms, cubic-bezier(0.2, 0, 0, 1), and scale 1 ↔ 0.96.
Reduced motion uses immediate 70% opacity while pressed. Disabled/busy actions stay stable.
The interaction target remains at least 44pt.

Reusable custom animation styles `MOH / Action press` and `MOH / Action release`
are saved in the library file. They are not yet published to consuming files: the
library has other pending changes, and broad publication was not performed.
SwiftUI uses `MOHMotion`/`MOHButtonStyle`; Vue uses `ActionButton.vue`.
These are gesture-driven effects; the specimen's demonstration timeline is not an autoplay requirement.

## Design and motion handoff

For a new interaction, include the Figma frame/master links and static design data.
When motion is present, include its timeline/context, trigger, properties, timing,
easing, delays, interruption, and reduced-motion behavior. Implement native SwiftUI
first and Vue/CSS second after the design direction is approved. Compare both clients
in light/dark, compact/regular layouts and with reduced motion enabled. Preserve useful
native/browser behavior. Do not add runtimes or assume Figma CSS is native iOS code.

Make can explore alternate flows; selected designs return to the UI Library. Weave,
audio, text animation, and Lottie are for an approved media brief. Generated media
that enters the product follows the [media review policy](../engineering-policy.md#media-ownership-and-review).
The [engineering policy](../engineering-policy.md#figma-is-the-visual-source-of-truth)
and shared `moh-designer` skill govern scope and tokens.

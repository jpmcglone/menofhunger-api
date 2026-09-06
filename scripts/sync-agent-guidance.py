#!/usr/bin/env python3
"""Sync canonical guidance to sibling repositories, or detect drift with --check."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true")
parser.add_argument("--repos-root", type=Path, default=Path(__file__).resolve().parents[2])
args = parser.parse_args()
repos = {name: args.repos_root / f"menofhunger-{name}" for name in ("api", "www", "ios")}
for repo in repos.values():
    if not (repo / "AGENTS.md").is_file():
        parser.error(f"Missing repository: {repo}; use --repos-root to select sibling checkouts")

shared = ("api-contract-sync", "design-simplicity-principles", "moh-designer", "moh-marketing", "ux-review")
pairs = [(repos["api"] / "docs/engineering-policy.md", repos[name] / "docs/engineering-policy.md")
         for name in ("www", "ios")]
for skill in shared:
    source = repos["api"] / ".agents/skills" / skill
    for file in sorted(source.rglob("*")):
        if file.is_file():
            pairs.extend((file, repos[name] / ".agents/skills" / skill / file.relative_to(source))
                         for name in ("www", "ios"))
source = repos["www"] / ".agents/skills/make-interfaces-feel-better"
for file in sorted(source.rglob("*")):
    if file.is_file():
        pairs.append((file, repos["ios"] / ".agents/skills/make-interfaces-feel-better" / file.relative_to(source)))

drift = []
for source, target in pairs:
    if target.exists() and source.read_bytes() == target.read_bytes():
        continue
    drift.append(str(target.relative_to(args.repos_root)))
    if not args.check:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
if drift:
    print(("Out of sync:\n" if args.check else "Updated:\n") + "\n".join(drift))
else:
    print(f"Guidance synchronized ({len(pairs)} checked copies).")
raise SystemExit(1 if args.check and drift else 0)

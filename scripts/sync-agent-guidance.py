#!/usr/bin/env python3
"""Sync canonical guidance to sibling repositories, or detect drift with --check.

Byte-copied: engineering-policy.md, shared skills, and the web polish skill.

Shared Cursor rules (15-feed-surface, 20-deletion-deprecation,
56-notification-seen-vs-read) are canonical in the API repository. Copies keep
their own YAML frontmatter (description/globs) and any section after
`<!-- guidance-addendum -->`. Do not edit a mirror body independently.

60-realtime-first is platform-specific and is not a checked copy.
"""
from __future__ import annotations

import argparse
from pathlib import Path

ADDENDUM_MARKER = "<!-- guidance-addendum -->"
SHARED_RULES = (
    "15-feed-surface.mdc",
    "20-deletion-deprecation.mdc",
    "56-notification-seen-vs-read.mdc",
)
SHARED_SKILLS = (
    "api-contract-sync",
    "design-simplicity-principles",
    "moh-designer",
    "moh-marketing",
    "ux-review",
)


def split_frontmatter(text: str) -> tuple[str, str]:
    if not text.startswith("---"):
        return "", text
    end = text.find("\n---\n", 3)
    if end == -1:
        return "", text
    stop = end + len("\n---\n")
    return text[:stop], text[stop:]


def split_addendum(body: str) -> tuple[str, str]:
    idx = body.find(ADDENDUM_MARKER)
    if idx == -1:
        return body, ""
    return body[:idx], body[idx:]


def shared_rule_body(text: str) -> str:
    _, body = split_frontmatter(text)
    shared, _ = split_addendum(body)
    return shared.strip() + "\n"


def compose_rule(frontmatter: str, shared: str, addendum: str) -> str:
    payload = shared.strip() + "\n"
    if not addendum:
        return f"{frontmatter}{payload}"
    extra = addendum if addendum.startswith(ADDENDUM_MARKER) else f"{ADDENDUM_MARKER}\n{addendum}"
    if not extra.endswith("\n"):
        extra += "\n"
    return f"{frontmatter}{payload}\n{extra}"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--repos-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument(
        "--allow-missing",
        nargs="*",
        default=[],
        metavar="REPO",
        help="Sibling repo names that may be absent (e.g. ios in CI without a checkout token)",
    )
    return parser.parse_args(argv)


def collect_pairs(repos: dict[str, Path]) -> list[tuple[Path, Path]]:
    pairs: list[tuple[Path, Path]] = []
    present = {name for name, path in repos.items() if name != "api"}
    for name in present:
        pairs.append((repos["api"] / "docs/engineering-policy.md", repos[name] / "docs/engineering-policy.md"))
    for skill in SHARED_SKILLS:
        source = repos["api"] / ".agents/skills" / skill
        for file in sorted(source.rglob("*")):
            if file.is_file():
                pairs.extend(
                    (file, repos[name] / ".agents/skills" / skill / file.relative_to(source))
                    for name in present
                )
    if "ios" in present:
        polish = repos["www"] / ".agents/skills/make-interfaces-feel-better"
        if polish.is_dir():
            for file in sorted(polish.rglob("*")):
                if file.is_file():
                    pairs.append(
                        (file, repos["ios"] / ".agents/skills/make-interfaces-feel-better" / file.relative_to(polish))
                    )
    return pairs


def collect_shared_rules(repos: dict[str, Path]) -> list[tuple[Path, Path]]:
    present = {name for name in ("www", "ios") if name in repos}
    return [
        (repos["api"] / ".cursor/rules" / name, repos[target] / ".cursor/rules" / name)
        for name in SHARED_RULES
        for target in present
    ]


def sync_bytes(source: Path, target: Path, check: bool, repos_root: Path) -> str | None:
    if target.exists() and source.read_bytes() == target.read_bytes():
        return None
    if not check:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    return str(target.relative_to(repos_root))


def sync_shared_rule(source: Path, target: Path, check: bool, repos_root: Path) -> str | None:
    source_body = shared_rule_body(source.read_text())
    if target.exists():
        target_text = target.read_text()
        frontmatter, body = split_frontmatter(target_text)
        _, addendum = split_addendum(body)
        if shared_rule_body(target_text) == source_body:
            return None
        if check:
            return str(target.relative_to(repos_root))
        target.write_text(compose_rule(frontmatter, source_body, addendum))
        return str(target.relative_to(repos_root))
    if check:
        return str(target.relative_to(repos_root))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(source.read_text())
    return str(target.relative_to(repos_root))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repos = {name: args.repos_root / f"menofhunger-{name}" for name in ("api", "www", "ios")}
    allow_missing = set(args.allow_missing)
    missing = [name for name, path in repos.items() if not (path / "AGENTS.md").is_file()]
    unexpected = [name for name in missing if name not in allow_missing]
    if unexpected:
        paths = ", ".join(str(repos[name]) for name in unexpected)
        raise SystemExit(f"Missing repository: {paths}; use --repos-root to select sibling checkouts")
    present = {name: path for name, path in repos.items() if (path / "AGENTS.md").is_file()}
    if "api" not in present or "www" not in present:
        raise SystemExit("menofhunger-api and menofhunger-www are required")

    drift: list[str] = []
    byte_pairs = collect_pairs(present)
    for source, target in byte_pairs:
        rel = sync_bytes(source, target, args.check, args.repos_root)
        if rel:
            drift.append(rel)

    for source, target in collect_shared_rules(present):
        rel = sync_shared_rule(source, target, args.check, args.repos_root)
        if rel:
            drift.append(rel)

    checked = len(byte_pairs) + len(collect_shared_rules(present))
    if drift:
        print(("Out of sync:\n" if args.check else "Updated:\n") + "\n".join(drift))
    else:
        skipped = ", ".join(sorted(allow_missing & set(missing)))
        suffix = f" Skipped missing: {skipped}." if skipped else ""
        print(f"Guidance synchronized ({checked} checked copies).{suffix}")
    return 1 if args.check and drift else 0


if __name__ == "__main__":
    raise SystemExit(main())

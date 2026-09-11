#!/usr/bin/env python3
"""Unit tests for shared-rule body/addendum handling in sync-agent-guidance.py."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import importlib.util

SCRIPT = Path(__file__).resolve().parent / "sync-agent-guidance.py"
SPEC = importlib.util.spec_from_file_location("sync_agent_guidance", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class SharedRuleParsing(unittest.TestCase):
    def test_shared_body_ignores_frontmatter_and_addendum(self) -> None:
        text = (
            "---\n"
            'description: Keep feed concepts consistent\n'
            'globs: "src/**/*.ts"\n'
            "alwaysApply: false\n"
            "---\n"
            "\n"
            "# Feed Surface\n"
            "\n"
            "Shared body.\n"
            "\n"
            "<!-- guidance-addendum -->\n"
            "\n"
            "## Local only\n"
        )
        self.assertEqual(MODULE.shared_rule_body(text), "# Feed Surface\n\nShared body.\n")

    def test_compose_preserves_addendum(self) -> None:
        frontmatter = '---\ndescription: x\nglobs: "pages/**"\nalwaysApply: false\n---\n'
        composed = MODULE.compose_rule(frontmatter, "# Feed Surface\n\nShared body.\n", "<!-- guidance-addendum -->\n\n## Local\n")
        self.assertTrue(composed.startswith(frontmatter))
        self.assertIn("# Feed Surface\n", composed)
        self.assertIn("<!-- guidance-addendum -->", composed)
        self.assertIn("## Local", composed)
        self.assertEqual(MODULE.shared_rule_body(composed), "# Feed Surface\n\nShared body.\n")


class SyncCheck(unittest.TestCase):
    def test_check_accepts_divergent_globs_and_addenda(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for name in ("api", "www", "ios"):
                repo = root / f"menofhunger-{name}"
                (repo / "docs").mkdir(parents=True)
                (repo / ".agents/skills").mkdir(parents=True)
                (repo / ".cursor/rules").mkdir(parents=True)
                (repo / "AGENTS.md").write_text(f"# {name}\n")
                (repo / "docs/engineering-policy.md").write_text("# Engineering policy\n")

            shared = (
                "---\n"
                'description: Keep feed concepts consistent across API, web, and iOS\n'
                "alwaysApply: false\n"
                "---\n"
                "\n"
                "# Feed Surface\n"
                "\n"
                "Shared body.\n"
            )
            (root / "menofhunger-api/.cursor/rules/15-feed-surface.mdc").write_text(
                shared.replace("alwaysApply: false", 'globs: "src/modules/posts/**/*.ts"\nalwaysApply: false')
            )
            (root / "menofhunger-www/.cursor/rules/15-feed-surface.mdc").write_text(
                shared.replace("alwaysApply: false", 'globs: "pages/**/*.vue"\nalwaysApply: false')
            )
            (root / "menofhunger-ios/.cursor/rules/15-feed-surface.mdc").write_text(
                shared.replace("alwaysApply: false", 'globs: "MenOfHunger/Domain/Feed/**/*.swift"\nalwaysApply: false')
                + "\n<!-- guidance-addendum -->\n\n## Filter transitions\n"
            )
            for name in ("20-deletion-deprecation.mdc", "56-notification-seen-vs-read.mdc"):
                body = f"---\ndescription: {name}\nalwaysApply: false\n---\n\n# {name}\n"
                for repo in ("api", "www", "ios"):
                    (root / f"menofhunger-{repo}/.cursor/rules" / name).write_text(body)

            self.assertEqual(MODULE.main(["--check", "--repos-root", str(root)]), 0)

    def test_check_reports_shared_body_drift(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            for name in ("api", "www"):
                repo = root / f"menofhunger-{name}"
                (repo / "docs").mkdir(parents=True)
                (repo / ".agents/skills").mkdir(parents=True)
                (repo / ".cursor/rules").mkdir(parents=True)
                (repo / "AGENTS.md").write_text(f"# {name}\n")
                (repo / "docs/engineering-policy.md").write_text("# Engineering policy\n")
            (root / "menofhunger-api/.cursor/rules/15-feed-surface.mdc").write_text(
                "---\ndescription: feed\nalwaysApply: false\n---\n\n# Feed Surface\n\nAPI body.\n"
            )
            (root / "menofhunger-www/.cursor/rules/15-feed-surface.mdc").write_text(
                "---\ndescription: feed\nalwaysApply: false\n---\n\n# Feed Surface\n\nWWW body.\n"
            )
            for name in ("20-deletion-deprecation.mdc", "56-notification-seen-vs-read.mdc"):
                body = f"---\ndescription: {name}\nalwaysApply: false\n---\n\n# {name}\n"
                for repo in ("api", "www"):
                    (root / f"menofhunger-{repo}/.cursor/rules" / name).write_text(body)
            self.assertEqual(
                MODULE.main(["--check", "--repos-root", str(root), "--allow-missing", "ios"]),
                1,
            )


if __name__ == "__main__":
    unittest.main()

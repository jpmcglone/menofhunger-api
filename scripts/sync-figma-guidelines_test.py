#!/usr/bin/env python3
"""Verify stale-source detection and honest Figma application receipts."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    "sync_figma_guidelines", Path(__file__).with_name("sync-figma-guidelines.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class GuidelineSync(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in [str(MODULE.DIRECTORY / part) for part in MODULE.PARTS] + list(MODULE.UPSTREAM):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"# {name}\n")
        self.args = ["--root", str(self.root)]
        self.url = "https://www.figma.com/design/test"

    def evidence(self) -> Path:
        files, _ = MODULE.build_bundle(self.root)
        path = self.root / "ui-evidence.json"
        path.write_text(json.dumps({
            "headers": {name: payload.decode().splitlines()[0] for name, payload in files.items()},
            "apply_confirmation": "Observed applied files in library guidelines panel",
        }))
        return path

    def test_export_does_not_claim_remote_application(self) -> None:
        self.assertEqual(MODULE.main(self.args), 0)
        self.assertEqual(MODULE.main(self.args + ["--check", "--local-only"]), 0)
        self.assertEqual(MODULE.main(self.args + ["--check"]), 1)
        self.assertFalse((self.root / MODULE.DIRECTORY / "applied.json").exists())

    def test_upstream_change_invalidates_verified_application(self) -> None:
        MODULE.main(self.args)
        self.assertEqual(MODULE.main(self.args + ["--record-applied", "--ui-evidence",
                         str(self.evidence()), "--figma-url", self.url]), 0)
        self.assertEqual(MODULE.main(self.args + ["--check"]), 0)
        (self.root / MODULE.UPSTREAM[0]).write_text("# Changed engineering policy\n")
        self.assertEqual(MODULE.main(self.args + ["--check"]), 1)
        self.assertEqual(MODULE.main(self.args), 0)
        self.assertEqual(MODULE.main(self.args + ["--check"]), 1)

    def test_incorrect_ui_header_cannot_create_receipt(self) -> None:
        MODULE.main(self.args)
        path = self.evidence()
        evidence = json.loads(path.read_text())
        evidence["headers"][MODULE.PARTS[0]] = "old revision"
        path.write_text(json.dumps(evidence))
        self.assertEqual(MODULE.main(self.args + ["--record-applied", "--ui-evidence",
                         str(path), "--figma-url", self.url]), 1)
        self.assertFalse((self.root / MODULE.DIRECTORY / "applied.json").exists())

    def test_exact_readback_detects_changed_remote_body(self) -> None:
        MODULE.main(self.args)
        files, _ = MODULE.build_bundle(self.root)
        readback = self.root / "readback"
        readback.mkdir()
        for name, payload in files.items():
            (readback / name).write_bytes(payload)
        self.assertEqual(MODULE.main(self.args + ["--record-applied", "--readback",
                         str(readback), "--figma-url", self.url]), 0)
        (readback / MODULE.PARTS[0]).write_bytes(files[MODULE.PARTS[0]] + b"Remote edit\n")
        self.assertEqual(MODULE.main(self.args + ["--check", "--readback", str(readback)]), 1)

    def test_upload_receipt_checks_actual_sources_and_records_limited_scope(self) -> None:
        MODULE.main(self.args)
        files, _ = MODULE.build_bundle(self.root)
        path = self.root / "upload-evidence.json"
        evidence = {
            "uploaded_files": {name: str(self.root / MODULE.DIRECTORY / "export" / name) for name in files},
            "observed_filenames": list(files),
            "apply_confirmation": "Changes applied. The agent will use your updated files.",
        }
        path.write_text(json.dumps(evidence))
        args = self.args + ["--record-applied", "--upload-evidence", str(path), "--figma-url", self.url]
        self.assertEqual(MODULE.main(args), 0)
        receipt = json.loads((self.root / MODULE.DIRECTORY / "applied.json").read_text())
        self.assertEqual(receipt["verification"], "upload-files-and-apply-confirmation")
        self.assertEqual(receipt["evidence"]["uploaded_sha256"],
                         {name: MODULE.digest(payload) for name, payload in files.items()})
        different = self.root / "different-upload.md"
        different.write_text("# Different actual upload\n")
        evidence["uploaded_files"][MODULE.PARTS[0]] = str(different)
        path.write_text(json.dumps(evidence))
        self.assertEqual(MODULE.main(args), 1)

    def test_changed_source_after_upload_cannot_rewrite_evidence_or_receipt(self) -> None:
        MODULE.main(self.args)
        export = self.root / MODULE.DIRECTORY / "export"
        original_export = {path.name: path.read_bytes() for path in export.iterdir()}
        path = self.root / "upload-evidence.json"
        path.write_text(json.dumps({
            "uploaded_files": {name: str(export / name) for name in MODULE.PARTS},
            "observed_filenames": list(MODULE.PARTS),
            "apply_confirmation": "Changes applied. The agent will use your updated files.",
        }))
        args = self.args + ["--record-applied", "--upload-evidence", str(path), "--figma-url", self.url]
        self.assertEqual(MODULE.main(args), 0)
        receipt_path = self.root / MODULE.DIRECTORY / "applied.json"
        original_receipt = receipt_path.read_bytes()
        (self.root / MODULE.DIRECTORY / MODULE.PARTS[0]).write_text("# Changed after upload\n")
        self.assertEqual(MODULE.main(args), 1)
        self.assertEqual({item.name: item.read_bytes() for item in export.iterdir()}, original_export)
        self.assertEqual(receipt_path.read_bytes(), original_receipt)


if __name__ == "__main__":
    unittest.main()

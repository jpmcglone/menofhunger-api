#!/usr/bin/env python3
"""Export canonical Figma guidelines and check the last verified Figma readback.

This script does not access Figma, credentials, or browser sessions. Exporting is
local-only. A receipt records exact downloaded Markdown, UI version headers, or
the actual local upload files plus observed filenames and Apply confirmation.
Upload confirmation does not verify remote file contents. No method is a live check.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = Path("docs/figma-guidelines")
PARTS = (
    "01-product-and-components.md",
    "02-materials-and-tokens.md",
    "03-platforms-and-handoff.md",
    "04-motion-and-exploration.md",
)
UPSTREAM = (
    "docs/engineering-policy.md",
    ".agents/skills/moh-designer/SKILL.md",
    ".agents/skills/design-simplicity-principles/SKILL.md",
)


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def build_bundle(root: Path) -> tuple[dict[str, bytes], bytes]:
    sources = [str(DIRECTORY / part) for part in PARTS] + list(UPSTREAM)
    hashes = {name: digest((root / name).read_bytes()) for name in sources}
    revision = digest(json_bytes(hashes))
    files = {}
    for part in PARTS:
        payload = (root / DIRECTORY / part).read_bytes()
        header = f"<!-- MoH guideline: {part}; revision: {revision}; payload-sha256: {digest(payload)} -->\n"
        files[part] = header.encode() + payload
    manifest = json_bytes({
        "schema_version": 1,
        "files": {name: digest(payload) for name, payload in files.items()},
        "source_revision": revision,
        "sources": hashes,
    })
    return files, manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Canonical API repository")
    parser.add_argument("--check", action="store_true", help="Check export and last verified application")
    parser.add_argument("--local-only", action="store_true", help="With --check, check only local export")
    parser.add_argument("--readback", type=Path, help="Directory of actual Markdown downloaded from Figma")
    parser.add_argument("--ui-evidence", type=Path, help="JSON with displayed file headers and Apply confirmation")
    parser.add_argument("--upload-evidence", type=Path, help="JSON with actual upload paths, observed filenames, and Apply confirmation")
    parser.add_argument("--record-applied", action="store_true", help="Record a verified application")
    parser.add_argument("--figma-url", help="Library design URL for the application receipt")
    args = parser.parse_args(argv)
    if args.record_applied and args.check:
        parser.error("--record-applied and --check cannot be combined")
    if args.record_applied and (not (args.readback or args.ui_evidence or args.upload_evidence) or not args.figma_url):
        parser.error("--record-applied requires verification evidence and --figma-url")
    if sum(bool(item) for item in (args.readback, args.ui_evidence, args.upload_evidence)) > 1:
        parser.error("Use one verification method at a time")
    if args.local_only and not args.check:
        parser.error("--local-only requires --check")

    root = args.root.resolve()
    bundle, manifest = build_bundle(root)
    export = root / DIRECTORY / "export"
    files = {export / name: payload for name, payload in bundle.items()}
    files[export / "manifest.json"] = manifest
    drift = [str(path.relative_to(root)) for path, value in files.items()
             if not path.is_file() or path.read_bytes() != value]
    if (args.check or args.record_applied) and drift:
        print("Local export out of sync:\n" + "\n".join(drift))
        if args.record_applied:
            print("Application receipt refused: export changed after upload; export and upload again first.")
        return 1
    if not args.check and not args.record_applied:
        export.mkdir(parents=True, exist_ok=True)
        for path, value in files.items():
            path.write_bytes(value)

    verification = None
    evidence = None
    if args.readback:
        for name, payload in bundle.items():
            readback = args.readback / name
            if not readback.is_file() or readback.read_bytes() != payload:
                print(f"Figma readback differs: {name}; no receipt recorded.")
                return 1
        verification = "exact-markdown-readback"
    if args.ui_evidence:
        evidence = json.loads(args.ui_evidence.read_text())
        expected = {name: payload.decode().splitlines()[0] for name, payload in bundle.items()}
        if evidence.get("headers") != expected or not evidence.get("apply_confirmation", "").strip():
            print("UI evidence must contain all actual displayed first-line headers and Apply confirmation.")
            return 1
        verification = "ui-headers-and-apply-confirmation"
    if args.upload_evidence:
        evidence = json.loads(args.upload_evidence.read_text())
        uploaded = evidence.get("uploaded_files", {})
        observed = evidence.get("observed_filenames", [])
        if (set(uploaded) != set(bundle) or sorted(observed) != sorted(bundle)
                or not evidence.get("apply_confirmation", "").strip()):
            print("Upload evidence requires all actual upload paths, observed filenames, and Apply confirmation.")
            return 1
        upload_hashes = {}
        for name, payload in bundle.items():
            upload = Path(uploaded[name])
            if not upload.is_file() or upload.read_bytes() != payload:
                print(f"Actual upload source differs: {name}; no receipt recorded.")
                return 1
            upload_hashes[name] = digest(payload)
        evidence["uploaded_sha256"] = upload_hashes
        verification = "upload-files-and-apply-confirmation"
    receipt_path = root / DIRECTORY / "applied.json"
    if args.record_applied:
        url = urlparse(args.figma_url)
        if url.scheme != "https" or url.hostname not in ("www.figma.com", "figma.com"):
            parser.error("--figma-url must be an https Figma URL")
        receipt_path.write_bytes(json_bytes({
            "schema_version": 1,
            "figma_url": args.figma_url,
            "manifest_sha256": digest(manifest),
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "verification": verification,
            "evidence": evidence,
        }))
        print(f"Recorded {verification}. This is a last-verified receipt, not a live check.")
        if verification == "upload-files-and-apply-confirmation":
            print("Verified the local files used and observed application; remote contents were not read back.")
        return 0

    if args.check and args.local_only:
        print("Canonical guideline export synchronized (local only; Figma not checked).")
        return 0
    receipt = json.loads(receipt_path.read_text()) if receipt_path.is_file() else {}
    current = (receipt.get("manifest_sha256") == digest(manifest)
               and receipt.get("verification") in (
                   "exact-markdown-readback", "ui-headers-and-apply-confirmation",
                   "upload-files-and-apply-confirmation"))
    if current:
        print(f"Export matches last verified Figma application: {receipt['verified_at']}.")
        print(f"Verification scope: {receipt['verification']}.")
        if receipt['verification'] == "upload-files-and-apply-confirmation":
            print("Receipt verifies local upload files and observed Apply confirmation, not remote contents.")
        if verification:
            print(f"Supplied current evidence also matches: {verification}.")
        else:
            print("Live Figma was not read; supply --readback to check a fresh download.")
        return 0
    print(f"Local export ready: {export}")
    print("PENDING FIGMA APPLICATION: upload the four .md files, observe their filenames, Apply changes.")
    print("Record genuine upload evidence with --record-applied --upload-evidence <json> --figma-url <library-url>.")
    return 1 if args.check else 0


if __name__ == "__main__":
    raise SystemExit(main())

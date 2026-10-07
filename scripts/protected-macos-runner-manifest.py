#!/usr/bin/env python3
"""Generate native-readonly runner pins from the exact official release archive."""
import argparse
import hashlib
from pathlib import Path
import tarfile

ARCHIVE_SHA256 = "df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog="Example: python3 scripts/protected-macos-runner-manifest.py actions-runner-osx-arm64-2.338.0.tar.gz",
    )
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    with args.archive.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != ARCHIVE_SHA256:
        parser.error("archive does not match the reviewed official 2.338.0 ARM64 release")
    pins = []
    with tarfile.open(args.archive, "r:gz") as archive:
        for member in archive.getmembers():
            path = member.name.removeprefix("./")
            if not path.startswith("bin/") or member.isdir():
                continue
            if not member.isfile() or any(part in ("", ".", "..") for part in path.split("/")):
                parser.error("unsupported native runner input")
            with archive.extractfile(member) as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            pins.append(f"{digest}\t{path}\n")
    destination = Path(__file__).with_name("protected-macos-runner-integrity.tsv")
    destination.write_text(f"# runner2.338.0 archiveSHA256={actual}\n" + "".join(sorted(pins)), encoding="utf8")
    print(f"Generated {len(pins)} reviewed apphost/managed/runtime/config input pins: {destination}")


if __name__ == "__main__":
    main()

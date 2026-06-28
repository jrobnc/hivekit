#!/usr/bin/env python3
"""Detect UUID collisions in an Xcode project.pbxproj.

Returns exit 0 if clean, 1 if collisions found. Prints one collision per line
in the form ``UUID  in PBXBuildFile + PBXFileReference``.

Usage:
    python3 check_pbxproj_uuids.py path/to/project.pbxproj
"""
from __future__ import annotations

import re
import sys


def collisions(text: str) -> list[tuple[str, str]]:
    build_files = set(re.findall(r"^\t\t([A-F0-9]{24})\s+/\*[^*]+\*/\s+=\s+\{isa = PBXBuildFile;", text, re.M))
    file_refs = set(re.findall(r"^\t\t([A-F0-9]{24})\s+/\*[^*]+\*/\s+=\s+\{isa = PBXFileReference;", text, re.M))
    groups = set(re.findall(r"^\t\t([A-F0-9]{24})\s+/\*[^*]+\*/\s+=\s+\{$", text, re.M))

    out = []
    for uuid in sorted(build_files & file_refs):
        out.append((uuid, "PBXBuildFile + PBXFileReference"))
    for uuid in sorted(build_files & groups):
        out.append((uuid, "PBXBuildFile + PBXGroup"))
    for uuid in sorted(file_refs & groups):
        out.append((uuid, "PBXFileReference + PBXGroup"))
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_pbxproj_uuids.py path/to/project.pbxproj", file=sys.stderr)
        return 2
    path = sys.argv[1]
    with open(path) as f:
        text = f.read()
    bad = collisions(text)
    if not bad:
        return 0
    for uuid, where in bad:
        print(f"{uuid}  in {where}")
    return 1


if __name__ == "__main__":
    sys.exit(main())

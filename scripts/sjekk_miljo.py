"""Sjekk at Python-miljøet virker og at private data holdes utenfor git.

Kjør fra roten av repoet:  python scripts/sjekk_miljo.py
"""

import subprocess
import sys
from importlib.metadata import version

from config import PRIVATE_DIR, RAW_DIR, ROOT, ensure_dirs

PAKKER = ["geopandas", "pyogrio", "shapely", "pyproj", "rasterio", "requests", "owslib", "matplotlib"]


def main() -> int:
    print(f"Python {sys.version.split()[0]}")
    for pakke in PAKKER:
        __import__(pakke)
        print(f"  {pakke:10s} {version(pakke)}")

    ensure_dirs()
    print("Datamapper er på plass.")

    # Kontroller at git ignorerer mappene som ikke skal publiseres.
    ok = True
    for mappe in (PRIVATE_DIR, RAW_DIR):
        testfil = mappe / "test.geojson"
        res = subprocess.run(
            ["git", "check-ignore", "-q", str(testfil.relative_to(ROOT))],
            cwd=ROOT,
        )
        status = "ignoreres av git" if res.returncode == 0 else "IKKE IGNORERT!"
        ok &= res.returncode == 0
        print(f"  {mappe.relative_to(ROOT).as_posix():15s} {status}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

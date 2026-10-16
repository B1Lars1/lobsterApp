"""Fyll inn fillisten og versjonen i app/sw.js.

Service workeren lagrer filene i listen på telefonen, så appen virker uten nett.
Versjonen er en sjekksum av alle filene. Endres en fil, endres versjonen, og
telefonen henter den nye versjonen neste gang appen åpnes med nett. Hver fil har
også sin egen sjekksum, så telefonen bare laster ned filene som er endret.

Kjør etter endringer i appen eller dataene (GitHub Actions-workflowen gjør det
også automatisk ved publisering):  python scripts/lag_service_worker.py
"""

import hashlib
import json
import re
import sys

from config import ROOT

APP = ROOT / "app"
SW = APP / "sw.js"

# Filer som ikke trengs uten nett
UTELAT = {"sw.js"}
UTELAT_ENDELSER = {".md", ".map"}
UTELAT_NAVN = {"LICENSE"}
# Leaflets egne markør- og lagbilder: appen tegner alle symbolene selv (L.divIcon)
UTELAT_MAPPER = ("vendor/leaflet-1.9.4/images/",)

# Tekstfiler: git kan sjekke dem ut med CRLF på Windows og LF ellers (.gitattributes).
# Sjekksummen regnes med LF, så versjonen blir den samme på alle maskiner og i workflowen.
TEKST_ENDELSER = {".html", ".css", ".js", ".json", ".geojson", ".webmanifest", ".svg"}


def filer_i_appen() -> list[str]:
    filer = []
    for sti in sorted(APP.rglob("*")):
        if not sti.is_file():
            continue
        rel = sti.relative_to(APP).as_posix()
        if (rel in UTELAT or sti.suffix in UTELAT_ENDELSER or sti.name in UTELAT_NAVN
                or rel.startswith(UTELAT_MAPPER)):
            continue
        filer.append(rel)
    return filer


def innhold(rel: str) -> bytes:
    data = (APP / rel).read_bytes()
    return data.replace(b"\r\n", b"\n") if (APP / rel).suffix in TEKST_ENDELSER else data


def main() -> int:
    filer = filer_i_appen()
    sjekksum = hashlib.sha256()
    per_fil = {}
    for rel in filer:
        data = innhold(rel)
        sjekksum.update(rel.encode())
        sjekksum.update(data)
        # Samme sjekksum som sw.js regner ut av filen den laster ned (SHA-256, 12 tegn)
        per_fil[rel] = hashlib.sha256(data).hexdigest()[:12]
    versjon = sjekksum.hexdigest()[:12]

    # './' er selve appen (index.html) når den åpnes fra hjemskjermen
    liste = {"./": per_fil["index.html"], **per_fil}
    generert = (
        "// <generert av scripts/lag_service_worker.py>\n"
        f"const VERSJON = '{versjon}';\n"
        "// Fil → sjekksum. Filer med samme sjekksum som i forrige versjon kopieres fra telefonen.\n"
        f"const FILER = {json.dumps(liste, indent=2, ensure_ascii=False).replace(chr(34), chr(39))};\n"
        "// </generert>"
    )
    tekst = SW.read_text(encoding="utf-8")
    ny, antall = re.subn(r"// <generert av scripts/lag_service_worker\.py>.*?// </generert>",
                         lambda _: generert, tekst, flags=re.S)
    if antall != 1:
        print("Fant ikke den genererte delen i sw.js")
        return 1
    SW.write_text(ny, encoding="utf-8")
    storrelse = sum((APP / rel).stat().st_size for rel in filer) / 1e6
    print(f"sw.js: versjon {versjon}, {len(liste)} filer ({storrelse:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

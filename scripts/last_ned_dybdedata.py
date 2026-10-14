"""Last ned Kartverkets «Sjøkart – Dybdedata» for kommunene rundt Lillesand.

Bruker Geonorges åpne nedlastings-API (ingen innlogging, CC BY 4.0).
Filene legges i data/raw/dybdedata/ og pakkes ut der.

Kjør fra roten av repoet:  python scripts/last_ned_dybdedata.py [--force]
"""

import argparse
import json
import sys
import time
import zipfile
from datetime import date

import requests

from config import RAW_DIR, ensure_dirs

API = "https://nedlasting.geonorge.no/api"
DATASET_UUID = "2751aacf-5472-4850-a208-3532a51c529a"  # Sjøkart – Dybdedata
FORMAT = "FGDB"        # Esri File Geodatabase, leses direkte av GeoPandas
PROJEKSJON = "25832"   # EUREF89 UTM sone 32

# Kommuner med sjø innenfor kartutsnittet (sjekket mot Kartverkets kommuneinfo).
KOMMUNER = {"4215": "Lillesand", "4202": "Grimstad", "4204": "Kristiansand"}

UT_DIR = RAW_DIR / "dybdedata"


def bestill(kommunenr: str, navn: str) -> dict:
    """Bestill én kommune og vent til filen er klar. Returnerer fil-info."""
    ordre = {
        "email": "",
        "softwareClient": "hummerkart-skript",
        "orderLines": [{
            "metadataUuid": DATASET_UUID,
            "areas": [{"code": kommunenr, "type": "kommune", "name": navn}],
            "projections": [{"code": PROJEKSJON}],
            "formats": [{"name": FORMAT}],
        }],
    }
    svar = requests.post(f"{API}/order", json=ordre, timeout=60)
    svar.raise_for_status()
    resultat = svar.json()

    # Ferdige kommunefiler er som regel klare med en gang, men vent litt om ikke.
    for _ in range(30):
        filer = resultat.get("files") or []
        if filer and all(f.get("status") == "ReadyForDownload" for f in filer):
            return filer[0] | {"referenceNumber": resultat["referenceNumber"]}
        time.sleep(10)
        resultat = requests.get(f"{API}/order/{resultat['referenceNumber']}", timeout=60).json()
    raise RuntimeError(f"Bestillingen for {navn} ble ikke klar: {resultat}")


def last_ned(fil: dict) -> None:
    zip_sti = UT_DIR / fil["name"]
    print(f"  laster ned {fil['name']} ...")
    with requests.get(fil["downloadUrl"], stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(zip_sti, "wb") as f:
            for bit in r.iter_content(chunk_size=1 << 20):
                f.write(bit)
    print(f"  {zip_sti.stat().st_size / 1e6:.1f} MB, pakker ut ...")
    with zipfile.ZipFile(zip_sti) as z:
        z.extractall(UT_DIR / zip_sti.stem)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="last ned på nytt selv om filene finnes")
    args = parser.parse_args()

    ensure_dirs()
    UT_DIR.mkdir(parents=True, exist_ok=True)

    logg = []
    for nr, navn in KOMMUNER.items():
        if not args.force and any(UT_DIR.glob(f"*_{nr}_*{FORMAT}")):
            print(f"{nr} {navn}: finnes allerede (bruk --force for å laste ned på nytt)")
            continue
        print(f"{nr} {navn}: bestiller ...")
        fil = bestill(nr, navn)
        last_ned(fil)
        logg.append({"kommune": nr, "fil": fil["name"], "ordre": fil["referenceNumber"],
                     "lastet_ned": date.today().isoformat()})

    if logg:
        # Enkel kildelogg, så vi vet hvilken versjon av dataene som er brukt.
        logg_sti = UT_DIR / "nedlastinger.json"
        tidligere = json.loads(logg_sti.read_text(encoding="utf-8")) if logg_sti.exists() else []
        logg_sti.write_text(json.dumps(tidligere + logg, indent=2, ensure_ascii=False),
                            encoding="utf-8")
    print("Ferdig.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

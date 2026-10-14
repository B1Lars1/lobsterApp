"""Hent fredningsområder for hummer i Agder fra Fiskeridirektoratet.

Kilde: datasettet «Hummer – fredningsområder» (Fiskeridirektoratet, lisens NLOD),
WFS-laget FiskeridirWFS_fiskeri:hummer_fredningsomraader (lagnavnet er hentet fra
GetCapabilities). Rådata lagres i data/raw/fiskeridir/, og områdene i Agder skrives til
app/data/fredningsomrader.geojson med egenskapene:

  navn       områdets navn
  regel      hva som er forbudt (teksten fra Fiskeridirektoratet)
  forskrift  lenke til forskriften
  oversikt   lenke til Fiskeridirektoratets side om frednings- og bevaringsområder

Kjør fra roten av repoet:  python scripts/lag_fredningsomrader.py
"""

import json
import sys
from datetime import date

import geopandas as gpd
import requests
from shapely.geometry import box

from config import AGDER_BBOX_WGS84, APP_DATA_DIR, CRS_WGS84, RAW_DIR, ensure_dirs

WFS = "https://gis.fiskeridir.no/server/services/FiskeridirWFS_fiskeri/MapServer/WFSServer"
LAG = "FiskeridirWFS_fiskeri:hummer_fredningsomraader"
METADATA = "https://kartkatalog.geonorge.no/metadata/8901e1f8-b947-4f7d-819c-bf11e3e16a68"

RAADATA = RAW_DIR / "fiskeridir" / "hummer_fredningsomraader.gml"
UT = APP_DATA_DIR / "fredningsomrader.geojson"


def last_ned() -> None:
    """Hent alle fredningsområdene i landet (ca. 3 MB) som GML i EPSG:4326."""
    RAADATA.parent.mkdir(parents=True, exist_ok=True)
    svar = requests.get(WFS, params={
        "SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature",
        "TYPENAMES": LAG, "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
    }, timeout=120)
    svar.raise_for_status()
    RAADATA.write_bytes(svar.content)
    print(f"Lastet ned {RAADATA.name} ({len(svar.content) / 1e6:.1f} MB)")


def main() -> int:
    ensure_dirs()
    last_ned()

    alle = gpd.read_file(RAADATA).to_crs(CRS_WGS84)
    agder = alle[alle.intersects(box(*AGDER_BBOX_WGS84))].copy()
    print(f"{len(alle)} områder i landet, {len(agder)} i Agder:")
    for navn in sorted(agder["navn"]):
        print(f"  {navn}")

    ut = gpd.GeoDataFrame({
        "navn": agder["navn"],
        "regel": agder["info"],
        "forskrift": agder["forskrift"],
        "oversikt": agder["url"],
    }, geometry=agder.geometry, crs=CRS_WGS84)
    UT.unlink(missing_ok=True)
    ut.to_file(UT, driver="GeoJSON", engine="pyogrio",
               layer_options={"RFC7946": "YES", "COORDINATE_PRECISION": 6})
    print(f"Skrev {UT.name} ({UT.stat().st_size / 1e3:.0f} kB)")

    # Kildeinformasjon som appen viser
    kilder_sti = APP_DATA_DIR / "kilder.json"
    kilder = json.loads(kilder_sti.read_text(encoding="utf-8")) if kilder_sti.exists() else {}
    kilder["fredningsomrader"] = {
        "navn": "Hummer – fredningsområder",
        "eier": "Fiskeridirektoratet",
        "kreditering": "Inneholder data under Norsk lisens for offentlige data (NLOD) "
                       "tilgjengeliggjort av Fiskeridirektoratet",
        "lisens": "NLOD",
        "lisens_url": "https://data.norge.no/nlod/no/1.0",
        "metadata_url": METADATA,
        "lastet_ned": date.today().isoformat(),
        "merknad": "Sjekk alltid gjeldende forskrift hos Fiskeridirektoratet.",
    }
    kilder_sti.write_text(json.dumps(kilder, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("Oppdaterte kilder.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

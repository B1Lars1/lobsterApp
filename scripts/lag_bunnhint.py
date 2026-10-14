"""Hent marine naturtyper som sier noe om bunnen (Miljødirektoratet, HB19).

Kilde: «Marine naturtyper (HB19)», Miljødirektoratet, lisens NLOD 2.0. Hentes fra
ArcGIS-tjenesten naturtyper_marine_hb19 (lagene er sjekket i tjenestens beskrivelse).

Naturtypene brukes som hint om bunnen der teinene skal stå:
  hard  Større tareskogforekomster: tare vokser på fjell og stein
  blot  Ålegrassamfunn, skjellsand og bløtbunnsområder: sand og mudder

Merk: tareskog og skjellsand er for det meste modellert, ikke kartlagt i felt.
Der det ikke er registrert noe, vet vi ikke hva bunnen er.

Skriver app/data/bunnhint.geojson med egenskapene «kategori» (hard/blot), «navn»,
«modellert» (true/false) og «aar» (år for datafangst). Krever at
scripts/lag_dybdekart.py er kjørt (bruker kartområdet derfra).

Kjør fra roten av repoet:  python scripts/lag_bunnhint.py
"""

import json
import sys
from datetime import date, datetime, timezone

import geopandas as gpd
import pandas as pd
import requests

from config import APP_DATA_DIR, BBOX_WGS84, CRS_UTM32, CRS_WGS84, PROCESSED_DIR, RAW_DIR, ensure_dirs

TJENESTE = "https://kart.miljodirektoratet.no/arcgis/rest/services/naturtyper_marine_hb19/MapServer"
METADATA = "https://kartkatalog.geonorge.no/metadata/e4f40b02-7a32-4163-87af-d4121de48e6d"

# lag-id i tjenesten -> kategori
LAG = {1: "hard", 6: "blot", 7: "blot", 8: "blot"}  # tare, bløtbunn, ålegras, skjellsand
NATURTYPER = {
    "I01": "Tareskog",
    "I08": "Bløtbunnsområde i strandsonen",
    "I11": "Ålegras",
    "I12": "Skjellsand",
}

RAA_DIR = RAW_DIR / "miljodirektoratet"
GPKG = PROCESSED_DIR / "dybdedata_lillesand.gpkg"
UT = APP_DATA_DIR / "bunnhint.geojson"
FORENKLING_M = 2


def hent_lag(lag: int) -> dict:
    """Hent alle objekter i kartutsnittet fra ett lag (med sidevis henting)."""
    alle, start = [], 0
    while True:
        svar = requests.get(f"{TJENESTE}/{lag}/query", params={
            "geometry": ",".join(map(str, BBOX_WGS84)), "geometryType": "esriGeometryEnvelope",
            "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects",
            "outFields": "naturtype,utforming,modellert,datafangstdato,omraadenavn",
            "resultOffset": start, "resultRecordCount": 2000, "f": "geojson",
        }, timeout=120)
        svar.raise_for_status()
        d = svar.json()
        alle += d.get("features", [])
        if not d.get("properties", {}).get("exceededTransferLimit") and not d.get("exceededTransferLimit"):
            break
        start += 2000
    geojson = {"type": "FeatureCollection", "features": alle}
    (RAA_DIR / f"hb19_lag{lag}.geojson").write_text(json.dumps(geojson, ensure_ascii=False), encoding="utf-8")
    return geojson


def main() -> int:
    ensure_dirs()
    RAA_DIR.mkdir(parents=True, exist_ok=True)

    deler = []
    for lag, kategori in LAG.items():
        geojson = hent_lag(lag)
        if not geojson["features"]:
            continue
        gdf = gpd.GeoDataFrame.from_features(geojson["features"], crs=CRS_WGS84)
        gdf["kategori"] = kategori
        deler.append(gdf)
    data = gpd.GeoDataFrame(pd.concat(deler, ignore_index=True), crs=CRS_WGS84).to_crs(CRS_UTM32)

    omrade = gpd.read_file(GPKG, layer="kartomrade").geometry.iloc[0]
    data = data.clip(omrade)
    data = data[data.geom_type.isin(["Polygon", "MultiPolygon"])].copy()
    data["geometry"] = data.simplify(FORENKLING_M, preserve_topology=True)
    data = data[~data.is_empty]

    def aar(ms):
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).year if pd.notna(ms) else None

    ut = gpd.GeoDataFrame({
        "kategori": data["kategori"],
        "navn": data["naturtype"].map(NATURTYPER).fillna("Annen naturtype"),
        "modellert": data["modellert"].fillna(0).astype(int).eq(1),
        "aar": data["datafangstdato"].map(aar).astype("Int64"),
    }, geometry=data.geometry, crs=CRS_UTM32).to_crs(CRS_WGS84)

    print("Bunnhint i kartområdet:")
    for (kategori, navn), antall in ut.groupby(["kategori", "navn"]).size().items():
        print(f"  {kategori:5s} {navn:30s} {antall}")
    UT.unlink(missing_ok=True)
    ut.to_file(UT, driver="GeoJSON", engine="pyogrio", layer_options={"RFC7946": "YES", "COORDINATE_PRECISION": 5})
    print(f"Skrev {UT.name} ({UT.stat().st_size / 1e3:.0f} kB)")

    kilder_sti = APP_DATA_DIR / "kilder.json"
    kilder = json.loads(kilder_sti.read_text(encoding="utf-8")) if kilder_sti.exists() else {}
    kilder["bunnhint"] = {
        "navn": "Marine naturtyper (HB19)",
        "eier": "Miljødirektoratet",
        "kreditering": "Inneholder data under Norsk lisens for offentlige data (NLOD) "
                       "tilgjengeliggjort av Miljødirektoratet",
        "lisens": "NLOD 2.0",
        "lisens_url": "https://data.norge.no/nlod/no/2.0",
        "metadata_url": METADATA,
        "lastet_ned": date.today().isoformat(),
    }
    kilder_sti.write_text(json.dumps(kilder, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Lag stedsnavn for øyer, holmer, grunner og skjær til kartet.

Kilde: Kartverkets stedsnavn (Sentralt stedsnavnregister) via det åpne API-et
https://api.kartverket.no/stedsnavn/v1/ (lisens CC BY 4.0). Svarene lagres i
data/raw/stedsnavn/ og hentes bare på nytt med --force.

For å unngå et støyete kart får hvert navn et minste zoomnivå («zoom»):
  1. Hver navnetype har et laveste zoomnivå. Store øyer vises tidligst, deretter
     mindre øyer, holmer, grunner og båer, og til slutt skjær.
  2. For hvert zoomnivå plasseres navnene i viktighetsrekkefølge (type, så
     øyas størrelse). Et navn som ville overlappe et navn som allerede er plassert,
     venter til et høyere zoomnivå der det er plass.
Appen viser et navn når kartet er zoomet minst så langt inn.

Skriver app/data/stedsnavn.geojson med egenskapene «navn», «stil» (oy/holme/sjo)
og «zoom». Krever at scripts/lag_dybdekart.py er kjørt (bruker kartområdet derfra).

Kjør fra roten av repoet:  python scripts/lag_stedsnavn.py [--force]
"""

import argparse
import json
import math
import sys
from datetime import date

import geopandas as gpd
import pandas as pd
import requests

from config import APP_DATA_DIR, CRS_UTM32, CRS_WGS84, PROCESSED_DIR, RAW_DIR, ensure_dirs

API = "https://api.kartverket.no/stedsnavn/v1/sted"
KOMMUNER = {"4204": "Kristiansand", "4215": "Lillesand", "4202": "Grimstad"}
RAA_DIR = RAW_DIR / "stedsnavn"
GPKG = PROCESSED_DIR / "dybdedata_lillesand.gpkg"
UT = APP_DATA_DIR / "stedsnavn.geojson"

# navneobjekttype -> (stil, prioritet, laveste zoom). Lavere prioritet plasseres først.
# Bare typene «i sjø», så navn på holmer i ferskvann ikke kommer med.
TYPER = {
    "Øygruppe i sjø": ("oy", 0, 13),
    "Holmegruppe i sjø": ("holme", 1, 14),
    "Øy i sjø": ("oy", 2, None),      # laveste zoom avhenger av øyas areal, se zoom_for_oy()
    "Holme i sjø": ("holme", 3, None),
    "Grunne i sjø": ("sjo", 4, 14),
    "Båe i sjø": ("sjo", 5, 15),
    "Klakk i sjø": ("sjo", 5, 15),
    "Bakketopp i sjø": ("sjo", 6, 15),
    "Skjær i sjø": ("holme", 7, 16),
}

# Skriftstørrelse i appen (px) og omtrentlig bokstavbredde, brukt til å beregne plassbehov
SKRIFT = {"oy": 14, "holme": 12, "sjo": 12}
BOKSTAVBREDDE = 0.58
SJO_FORSKYVNING = 11  # sjønavn står litt under punktet, så de ikke dekker dybdetallet
LUFT_X, LUFT_Y = 14, 8  # minste luft mellom navn (px), så kartet ikke blir tettpakket
STORSTE_ZOOM = 18


def hent_kommune(knr: str, force: bool) -> list:
    sti = RAA_DIR / f"{knr}.json"
    if sti.exists() and not force:
        return json.loads(sti.read_text(encoding="utf-8"))
    alle, side = [], 1
    while True:
        svar = requests.get(API, params={"knr": knr, "utkoordsys": 4258, "treffPerSide": 500, "side": side},
                            timeout=60)
        svar.raise_for_status()
        d = svar.json()
        alle += d["navn"]
        if not d["navn"] or d["metadata"]["viserTil"] >= d["metadata"]["totaltAntallTreff"]:
            break
        side += 1
    sti.write_text(json.dumps(alle, ensure_ascii=False), encoding="utf-8")
    print(f"  {KOMMUNER[knr]}: {len(alle)} navn hentet")
    return alle


def hovednavn(sted: dict) -> str | None:
    for n in sted.get("stedsnavn", []):
        if n.get("navnestatus") == "hovednavn":
            return n.get("skrivemåte")
    return None


def zoom_for_oy(areal_km2: float, stil: str) -> int:
    if stil == "oy":
        return 11 if areal_km2 >= 1 else 12 if areal_km2 >= 0.2 else 13 if areal_km2 >= 0.03 else 14
    return 14 if areal_km2 >= 0.05 else 15 if areal_km2 >= 0.005 else 16  # holme


def tilVerden(lon: float, lat: float) -> tuple[float, float]:
    """Web Mercator 0–1, samme som i appen."""
    s = math.sin(math.radians(lat))
    return (lon + 180) / 360, 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)


def fordel_zoom(navn: pd.DataFrame) -> pd.Series:
    """Gi hvert navn laveste zoomnivå der det får plass uten å overlappe andre navn."""
    navn = navn.sort_values(["prioritet", "areal_km2", "navn"], ascending=[True, False, True])
    verden = [tilVerden(lon, lat) for lon, lat in zip(navn.lon, navn.lat)]
    zoom = {}
    for z in range(11, STORSTE_ZOOM + 1):
        skala = 256 * 2**z
        ruter: dict[tuple[int, int], list] = {}  # enkelt rutenett for raske overlappsjekker

        def plass(boks, legg_til):
            x0, y0, x1, y1 = (int(v // 64) for v in boks)
            celler = [(cx, cy) for cx in range(x0, x1 + 1) for cy in range(y0, y1 + 1)]
            for c in celler:
                for b in ruter.get(c, ()):
                    if boks[0] < b[2] and boks[2] > b[0] and boks[1] < b[3] and boks[3] > b[1]:
                        return False
            if legg_til:
                for c in celler:
                    ruter.setdefault(c, []).append(boks)
            return True

        def boks_for(rad, wx, wy):
            storrelse = SKRIFT[rad.stil]
            bredde = len(rad.navn) * storrelse * BOKSTAVBREDDE + 2 * LUFT_X
            hoyde = storrelse + 2 * LUFT_Y
            x = wx * skala
            y = wy * skala + (SJO_FORSKYVNING if rad.stil == "sjo" else 0)
            return (x - bredde / 2, y - hoyde / 2, x + bredde / 2, y + hoyde / 2)

        rekker = list(zip(navn.iterrows(), verden))
        # 1) Navn som allerede vises fra et lavere zoomnivå, beholder plassen sin.
        for (idx, rad), (wx, wy) in rekker:
            if idx in zoom:
                plass(boks_for(rad, wx, wy), legg_til=True)
        # 2) Nye navn i viktighetsrekkefølge, hvis de får plass.
        for (idx, rad), (wx, wy) in rekker:
            if idx in zoom or rad.minzoom > z:
                continue
            boks = boks_for(rad, wx, wy)
            if plass(boks, legg_til=False):
                plass(boks, legg_til=True)
                zoom[idx] = z
    return pd.Series(zoom)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="hent navnene på nytt fra API-et")
    args = parser.parse_args()
    ensure_dirs()
    RAA_DIR.mkdir(parents=True, exist_ok=True)

    print("Henter stedsnavn:")
    rader = []
    for knr in KOMMUNER:
        for sted in hent_kommune(knr, args.force):
            typ = sted.get("navneobjekttype")
            navn = hovednavn(sted)
            punkt = sted.get("representasjonspunkt") or {}
            if typ in TYPER and navn and sted.get("stedstatus", "aktiv") == "aktiv" and punkt:
                rader.append({"stedsnummer": sted.get("stedsnummer"), "navn": navn, "type": typ,
                              "lon": punkt["øst"], "lat": punkt["nord"]})
    df = pd.DataFrame(rader).drop_duplicates("stedsnummer")
    gdf = gpd.GeoDataFrame(df, geometry=gpd.points_from_xy(df.lon, df.lat), crs="EPSG:4258")
    gdf = gdf.to_crs(CRS_UTM32)

    # Bare navn innenfor kartområdet fra lag_dybdekart.py
    omrade = gpd.read_file(GPKG, layer="kartomrade").geometry.iloc[0]
    gdf = gdf[gdf.within(omrade)].copy()

    # Øyas areal: landflaten navnepunktet ligger på (eller nærmeste innen 30 m)
    land = gpd.read_file(GPKG, layer="landareal")[["geometry"]]
    land["areal_km2"] = land.area / 1e6
    gdf = gpd.sjoin_nearest(gdf, land, how="left", max_distance=30).drop(columns="index_right")
    gdf = gdf[~gdf.index.duplicated()]
    gdf["areal_km2"] = gdf["areal_km2"].fillna(0)

    gdf["stil"] = gdf["type"].map(lambda t: TYPER[t][0])
    gdf["prioritet"] = gdf["type"].map(lambda t: TYPER[t][1])
    gdf["minzoom"] = [
        TYPER[t][2] if TYPER[t][2] is not None else zoom_for_oy(a, TYPER[t][0])
        for t, a in zip(gdf["type"], gdf["areal_km2"])
    ]
    gdf["zoom"] = fordel_zoom(gdf)
    utelatt = gdf["zoom"].isna().sum()
    gdf = gdf.dropna(subset=["zoom"])
    gdf["zoom"] = gdf["zoom"].astype(int)

    print(f"{len(gdf)} navn med i kartet ({utelatt} får aldri plass og er utelatt).")
    print("Antall navn som vises på hvert zoomnivå:")
    for z in range(11, STORSTE_ZOOM + 1):
        print(f"  zoom {z}: {(gdf['zoom'] <= z).sum()}")

    ut = gdf[["navn", "stil", "zoom", "geometry"]].to_crs(CRS_WGS84)
    UT.unlink(missing_ok=True)
    ut.to_file(UT, driver="GeoJSON", engine="pyogrio", layer_options={"RFC7946": "YES", "COORDINATE_PRECISION": 5})
    print(f"Skrev {UT.name} ({UT.stat().st_size / 1e3:.0f} kB)")

    kilder_sti = APP_DATA_DIR / "kilder.json"
    kilder = json.loads(kilder_sti.read_text(encoding="utf-8")) if kilder_sti.exists() else {}
    kilder["stedsnavn"] = {
        "navn": "Stedsnavn (Sentralt stedsnavnregister)",
        "eier": "Kartverket",
        "kreditering": "© Kartverket",
        "lisens": "CC BY 4.0",
        "lisens_url": "https://creativecommons.org/licenses/by/4.0/",
        "kilde_url": "https://api.kartverket.no/stedsnavn/v1/",
        "lastet_ned": date.today().isoformat(),
    }
    kilder_sti.write_text(json.dumps(kilder, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

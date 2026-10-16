"""Lag små filer med dybdedata for appen.

Leser Kartverkets «Sjøkart – Dybdedata» (FGDB) fra data/raw/dybdedata/, klipper til
kartområdet (land i utsnittet og sjø inntil SJO_AVSTAND_M fra land), forenkler,
reprojiserer til EPSG:4326 og skriver til app/data/:

  dybdekurver.geojson  dybdekurver med egenskapen «dybde» (m)
  kurveetiketter.json  punkter for dybdetall langs kurvene («dybde», «vinkel», «niva»)
  dybdeareal.geojson   dybdeområder med «min» og «maks» (m), for farger og dybdeoppslag
  land.geojson         land og tørrfall («kategori»), brukes som grunnkart offline
  dybdetall.json       dybdepunkter og grunner («kategori», «dybde»)
  kilder.json          kilde, lisens og nedlastingsdato

Punktene (*.json) er i et kompakt format, ikke GeoJSON, fordi det er mange av dem
(se skriv_punkter): { "felt": ["lon", "lat", ...], "punkter": [[lon, lat, ...], ...] }.

Klippede data i full oppløsning (UTM32) lagres i data/processed/dybdedata_lillesand.gpkg
for analyse i GeoPandas.

Kjør fra roten av repoet:  python scripts/lag_dybdekart.py
"""

import gzip
import json
import sys
import warnings

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
import shapely
from shapely.geometry import box

from config import (APP_DATA_DIR, BBOX_WGS84, CRS_UTM32, CRS_WGS84, PROCESSED_DIR, RAW_DIR, ROOT,
                    SJO_AVSTAND_M, ensure_dirs)

KILDE_DIR = RAW_DIR / "dybdedata"
GPKG = PROCESSED_DIR / "dybdedata_lillesand.gpkg"

LAG = ["dybdekurve", "dybdeareal", "dybdepunkt", "grunne", "skjer", "landareal", "torrfall"]

# Forenkling (i meter, UTM32). Kildedataene er laget for målestokk 1:50 000,
# så detaljer under ca. 10 m er uansett usikre.
TOL_KURVE = 3    # Douglas-Peucker for dybdekurver
TOL_AREAL = 15   # «coverage»-forenkling: naboflater forenkles likt, så det ikke blir sprekker
PRESISJON = 5    # desimaler i lon/lat (ca. 1 m)

ETIKETT_AVSTAND = 300  # meter mellom etiketter langs en dybdekurve


def lag_kurveetiketter(kurver: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Finn punkter og vinkler for dybdetall langs kurvene.

    «niva» styrer hvor tett etikettene vises: appen viser nivå 0 fra zoom 13,
    nivå 1 fra zoom 14 osv. Lange kurver og annenhver etikett får lavt nivå,
    så kartet ikke blir overfylt når du zoomer ut.
    """
    rader = []
    for dybde, linje in zip(kurver["dybde"], kurver.geometry):
        lengde = linje.length
        if lengde < 80:
            continue
        if lengde < ETIKETT_AVSTAND:
            avstander = np.array([lengde / 2])
        else:
            avstander = np.arange(ETIKETT_AVSTAND / 2, lengde, ETIKETT_AVSTAND)
        lengde_niva = 0 if lengde > 4000 else 1 if lengde > 2000 else 2 if lengde > 600 else 3

        punkter = shapely.line_interpolate_point(linje, avstander)
        foran = shapely.line_interpolate_point(linje, np.maximum(avstander - 15, 0))
        bak = shapely.line_interpolate_point(linje, np.minimum(avstander + 15, lengde))
        vinkler = np.degrees(np.arctan2(shapely.get_y(bak) - shapely.get_y(foran),
                                        shapely.get_x(bak) - shapely.get_x(foran)))
        vinkler = (vinkler + 90) % 180 - 90  # hold teksten rett vei (ikke opp ned)

        for i, (p, v) in enumerate(zip(punkter, vinkler)):
            pos_niva = 0 if i % 8 == 0 else 1 if i % 4 == 0 else 2 if i % 2 == 0 else 3
            rader.append({"dybde": int(dybde), "vinkel": int(round(v)),
                          "niva": max(pos_niva, lengde_niva), "geometry": p})
    return gpd.GeoDataFrame(rader, crs=kurver.crs)


def les_lag(gdbs, lag: str, utsnitt) -> gpd.GeoDataFrame:
    """Les ett lag fra alle kommunefilene, fjern duplikater og klipp til utsnittet."""
    deler = [
        gpd.read_file(g, layer=lag, bbox=utsnitt.bounds)
        for g in gdbs
        if lag in pyogrio.list_layers(g)[:, 0]
    ]
    df = pd.concat(deler, ignore_index=True).drop_duplicates("lokalid")
    df = df.drop(columns=["SHAPE_Length", "SHAPE_Area"], errors="ignore")
    gdf = gpd.GeoDataFrame(df, crs=CRS_UTM32).clip(utsnitt)

    # Klipping kan gi blandede geometrier (f.eks. en kurve som bare berører kanten blir
    # linje + punkt). Del opp i enkeltdeler og behold bare den høyeste dimensjonen.
    gdf = gdf.explode(index_parts=False)
    dim = shapely.get_dimensions(gdf.geometry.values)
    return gdf[dim == dim.max()]


def lag_kartomrade(gdbs, boks):
    """Kartområdet: alt land i utsnittet og sjø inntil SJO_AVSTAND_M fra nærmeste land.

    Slik følger kartet kysten uten å ta med åpent hav langt ute.
    """
    land = les_lag(gdbs, "landareal", boks)
    # Forenkle før buffring, ellers tar det lang tid med tusenvis av holmer
    kyst = shapely.union_all(land.geometry.simplify(25).values)
    omrade = kyst.buffer(SJO_AVSTAND_M, quad_segs=4).intersection(boks).simplify(50)
    print(f"Kartområde: {omrade.area / 1e6:.0f} km² (utsnittet er {boks.area / 1e6:.0f} km²)")
    return omrade


def skriv_geojson(gdf: gpd.GeoDataFrame, navn: str) -> None:
    sti = APP_DATA_DIR / navn
    sti.unlink(missing_ok=True)
    gdf = gdf.to_crs(CRS_WGS84)
    # Rund av koordinatene slik at geometrien fortsatt er gyldig etterpå.
    gdf["geometry"] = shapely.set_precision(gdf.geometry.values, 10**-PRESISJON)
    gdf = gdf[~gdf.is_empty]
    gdf.to_file(
        sti, driver="GeoJSON", engine="pyogrio",
        layer_options={"RFC7946": "YES", "COORDINATE_PRECISION": PRESISJON},
    )
    kb = sti.stat().st_size / 1e3
    kb_gz = len(gzip.compress(sti.read_bytes())) / 1e3
    print(f"  {navn:22s} {len(gdf):6d} objekter  {kb:6.0f} kB  ({kb_gz:4.0f} kB komprimert)")


def skriv_punkter(gdf: gpd.GeoDataFrame, navn: str, felt: list[str]) -> None:
    """Punkter i et kompakt format som appen leser raskere og med mindre minne enn GeoJSON
    (dybdelag.js, lagPunkterFraListe): én rad [lon, lat, felt ...] per punkt."""
    sti = APP_DATA_DIR / navn
    gdf = gdf.to_crs(CRS_WGS84)
    gdf = gdf[~gdf.is_empty]
    kolonner = [gdf.geometry.x.round(PRESISJON).tolist(), gdf.geometry.y.round(PRESISJON).tolist(),
                *(gdf[f].tolist() for f in felt)]
    rader = [json.dumps(list(rad), ensure_ascii=False, allow_nan=False, separators=(",", ":"))
             for rad in zip(*kolonner)]
    # Én rad per linje, så endringer kan leses i git
    tekst = '{"felt": ' + json.dumps(["lon", "lat", *felt]) + ', "punkter": [\n' + ",\n".join(rader) + "\n]}\n"
    sti.write_text(tekst, encoding="utf-8")
    kb = sti.stat().st_size / 1e3
    kb_gz = len(gzip.compress(sti.read_bytes())) / 1e3
    print(f"  {navn:22s} {len(gdf):6d} punkter   {kb:6.0f} kB  ({kb_gz:4.0f} kB komprimert)")


def main() -> int:
    ensure_dirs()
    # GDAL advarer om ytelse når et polygon har over 100 deler. Ufarlig her.
    warnings.filterwarnings("ignore", message="organizePolygons")

    gdbs = sorted(KILDE_DIR.glob("*/*.gdb"))
    if not gdbs:
        print("Fant ingen dybdedata. Kjør først:  python scripts/last_ned_dybdedata.py")
        return 1
    print("Leser", ", ".join(g.stem for g in gdbs))

    boks = gpd.GeoSeries([box(*BBOX_WGS84)], crs=CRS_WGS84).to_crs(CRS_UTM32).iloc[0]
    omrade = lag_kartomrade(gdbs, boks)
    data = {lag: les_lag(gdbs, lag, omrade) for lag in LAG}

    # 1) Full oppløsning for analyse
    GPKG.unlink(missing_ok=True)
    for lag, gdf in data.items():
        gdf.to_file(GPKG, layer=lag, driver="GPKG", engine="pyogrio")
    # Kartområdet brukes også av lag_stedsnavn.py
    gpd.GeoDataFrame(geometry=[omrade], crs=CRS_UTM32).to_file(GPKG, layer="kartomrade", driver="GPKG")
    print(f"Full oppløsning lagret i {GPKG.relative_to(ROOT).as_posix()}")

    # 2) Flater: dybdeareal, land og tørrfall forenkles samlet, så kantene passer sammen
    flater = pd.concat([
        data["dybdeareal"].assign(kategori="dybde"),
        data["landareal"].assign(kategori="land"),
        data["torrfall"].assign(kategori="torrfall"),
    ], ignore_index=True)
    flater = gpd.GeoDataFrame(flater, crs=CRS_UTM32)
    flater["geometry"] = flater.geometry.simplify_coverage(TOL_AREAL)
    flater = flater[~flater.is_empty]

    dybdeareal = flater[flater["kategori"] == "dybde"].rename(
        columns={"minimumsdybde": "min", "maksimumsdybde": "maks"})[["min", "maks", "geometry"]]
    # Slå sammen land (og tørrfall), så det ikke blir synlige sømmer der kildedataene er delt opp.
    land = (flater[flater["kategori"] != "dybde"][["kategori", "geometry"]]
            .dissolve("kategori").reset_index().explode(index_parts=False))

    # 3) Kurver
    kurver = data["dybdekurve"][["dybde", "geometry"]].copy()
    kurver["geometry"] = kurver.simplify(TOL_KURVE, preserve_topology=True)
    kurver = kurver[~kurver.is_empty]

    # 4) Dybdetall: dybdepunkter og grunner i ett punktlag. Skjær tas ikke med (symbolene
    #    gjorde kartet urolig), men ligger i GPKG-en.
    dybdetall = pd.concat([
        data["dybdepunkt"].assign(kategori="punkt"),
        data["grunne"].assign(kategori="grunne"),
    ], ignore_index=True)[["kategori", "dybde", "geometry"]]
    dybdetall["dybde"] = dybdetall["dybde"].astype(float).round(1)
    dybdetall = gpd.GeoDataFrame(dybdetall, crs=CRS_UTM32)

    print("Skriver til app/data/:")
    skriv_geojson(kurver, "dybdekurver.geojson")
    skriv_punkter(lag_kurveetiketter(kurver), "kurveetiketter.json", ["dybde", "vinkel", "niva"])
    skriv_geojson(dybdeareal, "dybdeareal.geojson")
    skriv_geojson(land, "land.geojson")
    skriv_punkter(dybdetall, "dybdetall.json", ["kategori", "dybde"])

    # 5) Kildeinformasjon som appen viser
    logg_sti = KILDE_DIR / "nedlastinger.json"
    nedlastet = max(r["lastet_ned"] for r in json.loads(logg_sti.read_text(encoding="utf-8")))
    kilder_sti = APP_DATA_DIR / "kilder.json"
    kilder = json.loads(kilder_sti.read_text(encoding="utf-8")) if kilder_sti.exists() else {}
    kilder["dybdedata"] = {
        "navn": "Sjøkart – Dybdedata",
        "eier": "Kartverket",
        "kreditering": "© Kartverket",
        "lisens": "CC BY 4.0",
        "lisens_url": "https://creativecommons.org/licenses/by/4.0/",
        "metadata_url": "https://kartkatalog.geonorge.no/metadata/2751aacf-5472-4850-a208-3532a51c529a",
        "lastet_ned": nedlastet,
        "merknad": "Ikke godkjent for navigasjon. Dybder er referert til sjøkartnull.",
    }
    kilder_sti.write_text(json.dumps(kilder, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("  kilder.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

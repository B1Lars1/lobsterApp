"""Finn bratt sjøbunn ut fra dybdedataene, som et hint om fjellbunn («kanten»).

Fremgangsmåte:
  1. Lag et triangelnett (TIN) av dybdepunkter, grunner, punktene langs dybdekurvene
     og kystlinjen (dybde 0).
  2. Regn ut helningen til hvert triangel.
  3. Slå sammen triangler som er brattere enn grensene under, til flater.
Triangler over land, utenfor kartområdet eller med sider lengre enn MAKS_KANT_M
(der det er langt mellom målingene) tas ikke med.

Dette er et anslag: Kartverkets åpne data har ca. 50 m mellom dybdepunktene, så
store kanter og skrenter kommer med, men ikke enkeltsteiner og små fjellnabber.

Skriver app/data/bratt.geojson med egenskapen «klasse» (bratt/svaertbratt).
Krever at scripts/lag_dybdekart.py er kjørt (bruker full oppløsning derfra).

Kjør fra roten av repoet:  python scripts/lag_bratt_bunn.py
"""

import sys

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from matplotlib.tri import Triangulation

from config import APP_DATA_DIR, CRS_UTM32, CRS_WGS84, PROCESSED_DIR

GPKG = PROCESSED_DIR / "dybdedata_lillesand.gpkg"
UT = APP_DATA_DIR / "bratt.geojson"

BRATT_GRADER = 20         # helning fra og med dette regnes som bratt
SVAERT_BRATT_GRADER = 35  # og fra og med dette som svært bratt
MAKS_KANT_M = 150         # lengre trekantsider betyr for lite data til å si noe
MINSTE_FLATE_M2 = 1000    # mindre flater er mest støy (og gjør filen stor)
FORENKLING_M = 4


def punkter_fra_linjer(geometrier, dybder, forenkling):
    """Hjørnepunktene i linjer/flatekanter, med en dybde per geometri."""
    xs, ys, zs = [], [], []
    for geom, z in zip(geometrier, dybder):
        koord = shapely.get_coordinates(shapely.simplify(geom, forenkling))
        xs.append(koord[:, 0])
        ys.append(koord[:, 1])
        zs.append(np.full(len(koord), z, dtype=float))
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(zs)


def main() -> int:
    print("Leser dybdedata ...")
    punkt = gpd.read_file(GPKG, layer="dybdepunkt")
    grunne = gpd.read_file(GPKG, layer="grunne")
    kurver = gpd.read_file(GPKG, layer="dybdekurve")
    land = gpd.read_file(GPKG, layer="landareal")
    torrfall = gpd.read_file(GPKG, layer="torrfall")
    omrade = gpd.read_file(GPKG, layer="kartomrade").geometry.iloc[0]

    x = [punkt.geometry.x.values, grunne.geometry.x.values]
    y = [punkt.geometry.y.values, grunne.geometry.y.values]
    z = [punkt["dybde"].values.astype(float), grunne["dybde"].values.astype(float)]
    for geometrier, dybder, forenkling in (
        (kurver.geometry.values, kurver["dybde"].values, 3),
        (land.geometry.boundary.values, np.zeros(len(land)), 5),
        (torrfall.geometry.boundary.values, np.zeros(len(torrfall)), 5),
    ):
        lx, ly, lz = punkter_fra_linjer(geometrier, dybder, forenkling)
        x.append(lx)
        y.append(ly)
        z.append(lz)
    x, y, z = np.concatenate(x), np.concatenate(y), np.concatenate(z)

    # Fjern punkter som ligger nesten oppå hverandre (gir problemer i trianguleringen)
    _, unike = np.unique(np.round(np.column_stack([x, y]) * 2), axis=0, return_index=True)
    x, y, z = x[unike], y[unike], z[unike]
    print(f"Triangulerer {len(x):,} punkter ...".replace(",", " "))
    tri = Triangulation(x, y)
    t = tri.triangles

    # Helning per triangel fra planet gjennom de tre hjørnene
    p = np.stack([x[t], y[t], z[t]], axis=-1)  # (n, 3 hjørner, xyz)
    normal = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    helning = np.degrees(np.arctan2(np.hypot(normal[:, 0], normal[:, 1]), np.abs(normal[:, 2])))

    kanter = np.stack([
        np.hypot(*(p[:, 1, :2] - p[:, 0, :2]).T),
        np.hypot(*(p[:, 2, :2] - p[:, 1, :2]).T),
        np.hypot(*(p[:, 0, :2] - p[:, 2, :2]).T),
    ], axis=1).max(axis=1)

    # Bare triangler i sjøen innenfor kartområdet
    cx, cy = p[:, :, 0].mean(axis=1), p[:, :, 1].mean(axis=1)
    landflate = shapely.union_all(land.geometry.values)
    shapely.prepare(landflate)
    shapely.prepare(omrade)
    i_sjoen = shapely.contains_xy(omrade, cx, cy) & ~shapely.contains_xy(landflate, cx, cy)
    gyldig = i_sjoen & (kanter <= MAKS_KANT_M)

    print("Helning i sjøen (triangler med nok data):")
    for g in (10, 20, 30, 35, 45):
        print(f"  ≥ {g:2d}°: {np.mean(helning[gyldig] >= g) * 100:5.1f} %")

    def flater(grense, klasse):
        valgt = gyldig & (helning >= grense)
        trekanter = shapely.polygons(p[valgt][:, :, :2])
        samlet = shapely.coverage_union_all(trekanter)
        deler = [d for d in shapely.get_parts(samlet) if d.area >= MINSTE_FLATE_M2]
        gdf = gpd.GeoDataFrame({"klasse": [klasse] * len(deler)}, geometry=deler, crs=CRS_UTM32)
        gdf["geometry"] = gdf.simplify(FORENKLING_M, preserve_topology=True)
        print(f"  {klasse}: {len(gdf)} flater, {gdf.area.sum() / 1e6:.1f} km²")
        return gdf

    print("Lager flater:")
    alle = pd.concat([flater(BRATT_GRADER, "bratt"), flater(SVAERT_BRATT_GRADER, "svaertbratt")],
                     ignore_index=True)
    ut = gpd.GeoDataFrame(alle, crs=CRS_UTM32).to_crs(CRS_WGS84)
    UT.unlink(missing_ok=True)
    ut.to_file(UT, driver="GeoJSON", engine="pyogrio", layer_options={"RFC7946": "YES", "COORDINATE_PRECISION": 5})
    print(f"Skrev {UT.name} ({UT.stat().st_size / 1e3:.0f} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

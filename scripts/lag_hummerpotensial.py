"""Anslå hvor det er størst sjanse for hummer («hummerpotensial»), og finn kanten
mellom tareskog og sand/ålegras.

Bygger på forskning om europeisk hummer (kildene står i README, «Hummerpotensial»):
  - dybde: mest på 10–30 m (Oslofjorden 10–25 m, generelt 5–40 m)
  - helning: i Tvedestrand forklarte helning, dybde og eksponering fangsten best
  - kanten der fjell møter sand: det beste habitatet i Biscaya-studien
  - steinbunn med tare
Eksponering for bølger er ikke med, siden det ikke finnes data for området.

Fremgangsmåte:
  1. Tarekant: kanten av tareskog (hard bunn) som ligger innenfor KANT_AVSTAND_M fra
     ålegras, skjellsand eller bløtbunn (bunnhintene fra lag_bunnhint.py).
  2. Dybde og helning i et rutenett på RUTE_M × RUTE_M meter, fra et triangelnett (TIN)
     av dybdepunkter, grunner, dybdekurver og kystlinjen (dybde 0).
  3. Poengsum 0–1 per rute: dybdeverdi × (vektet sum av helning, nærhet til tarekanten
     og tareskog). Dybdeverdien er 1 på 10–30 m og 0 grunnere enn 5 m og dypere enn 40 m,
     så de andre forholdene teller bare på riktig dybde.
  4. Ruter med poengsum over GRENSER blir flater med klasse «hoy» eller «middels».

Dette er et anslag, ikke en fasit. Kartverkets åpne data har ca. 50 m mellom
dybdepunktene, så små fjellnabber og steiner kommer ikke med. Juster vektene etter
hvert som fangstanalysen (analyser_fangst.py) viser hva som gir hummer.

Skriver:
  app/data/hummerpotensial.geojson     flater med «klasse» (hoy/middels)
  app/data/tarekant.geojson            linjer: kanten mellom tare og sand/ålegras
  data/processed/hummerpotensial.tif   rutenettet (dybde, helning, poengsum), brukes av
                                       analyser_fangst.py
Krever at lag_dybdekart.py og lag_bunnhint.py er kjørt.

Kjør fra roten av repoet:  python scripts/lag_hummerpotensial.py
"""

import json
import sys
from datetime import date

import geopandas as gpd
import numpy as np
import rasterio
import shapely
from matplotlib.tri import LinearTriInterpolator, Triangulation
from rasterio import features
from rasterio.transform import from_origin

from config import APP_DATA_DIR, CRS_UTM32, CRS_WGS84, PROCESSED_DIR

GPKG = PROCESSED_DIR / "dybdedata_lillesand.gpkg"
BUNNHINT = APP_DATA_DIR / "bunnhint.geojson"
UT_FLATER = APP_DATA_DIR / "hummerpotensial.geojson"
UT_KANT = APP_DATA_DIR / "tarekant.geojson"
UT_RUTENETT = PROCESSED_DIR / "hummerpotensial.tif"

RUTE_M = 20               # størrelsen på rutene i rutenettet
MAKS_KANT_M = 150         # lengre trekantsider i TIN-et betyr for lite data til å si noe
KANT_AVSTAND_M = 50       # tare så nær sand/ålegras regnes som en tarekant
MINSTE_KANT_M = 20        # kortere biter av tarekanten tas ikke med

DYBDE_M = (5, 10, 30, 40)  # dybdeverdi 0 → 1 fra 5 til 10 m, 1 til 30 m, 0 igjen ved 40 m
HELNING_GRADER = (5, 25)   # helningsverdi 0 ved 5°, 1 fra 25°
KANT_SONER_M = ((50, 1.0), (100, 0.6), (150, 0.3))  # nærhet til tarekanten
VEKT = {"helning": 0.5, "kant": 0.25, "tare": 0.25}
GRENSER = {"hoy": 0.5, "middels": 0.3}  # poengsum fra og med

MINSTE_FLATE_M2 = 2000
FORENKLING_M = 10


def punkter_fra_linjer(geometrier, dybder, forenkling):
    """Hjørnepunktene i linjer/flatekanter, med en dybde per geometri."""
    xs, ys, zs = [], [], []
    for geom, z in zip(geometrier, dybder):
        koord = shapely.get_coordinates(shapely.simplify(geom, forenkling))
        xs.append(koord[:, 0])
        ys.append(koord[:, 1])
        zs.append(np.full(len(koord), z, dtype=float))
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(zs)


def lag_tarekant(hint: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Kanten av tareskogen som ligger nær ålegras, skjellsand eller bløtbunn."""
    hard = shapely.union_all(hint.loc[hint["kategori"] == "hard"].geometry.values)
    blot = shapely.union_all(hint.loc[hint["kategori"] == "blot"].geometry.values)
    kant = shapely.line_merge(shapely.intersection(hard.boundary, blot.buffer(KANT_AVSTAND_M)))
    deler = [d for d in shapely.get_parts(kant) if d.length >= MINSTE_KANT_M]
    gdf = gpd.GeoDataFrame(geometry=deler, crs=CRS_UTM32)
    gdf["geometry"] = gdf.simplify(2)
    print(f"Tarekant: {len(gdf)} biter, {gdf.length.sum() / 1000:.1f} km")
    return gdf


def lag_dybdeflate(rader, kolonner, transform, i_sjoen):
    """Dybde (m) i midten av hver rute i sjøen, fra et triangelnett. NaN der data mangler."""
    punkt = gpd.read_file(GPKG, layer="dybdepunkt")
    grunne = gpd.read_file(GPKG, layer="grunne")
    kurver = gpd.read_file(GPKG, layer="dybdekurve")
    land = gpd.read_file(GPKG, layer="landareal")
    torrfall = gpd.read_file(GPKG, layer="torrfall")

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
    _, unike = np.unique(np.round(np.column_stack([x, y]) * 2), axis=0, return_index=True)
    x, y, z = x[unike], y[unike], z[unike]
    print(f"Triangulerer {len(x):,} punkter ...".replace(",", " "))
    tri = Triangulation(x, y)

    # Triangler med lange sider (lite data) gir ingen dybde
    t = tri.triangles
    sider = np.stack([np.hypot(x[t[:, a]] - x[t[:, b]], y[t[:, a]] - y[t[:, b]])
                      for a, b in ((0, 1), (1, 2), (2, 0))], axis=1).max(axis=1)
    tri.set_mask(sider > MAKS_KANT_M)

    rad, kol = np.nonzero(i_sjoen)
    sx, sy = rasterio.transform.xy(transform, rad, kol)
    dybde = np.full((rader, kolonner), np.nan, dtype=np.float32)
    verdier = LinearTriInterpolator(tri, z)(np.asarray(sx), np.asarray(sy))
    dybde[rad, kol] = np.ma.filled(verdier, np.nan)
    return dybde


def rampe(verdi, fra, til):
    """0 ved «fra», 1 ved «til», lineært imellom (fungerer begge veier)."""
    return np.clip((verdi - fra) / (til - fra), 0, 1)


def main() -> int:
    omrade = gpd.read_file(GPKG, layer="kartomrade").geometry.iloc[0]
    land = gpd.read_file(GPKG, layer="landareal").geometry.values
    hint = gpd.read_file(BUNNHINT).to_crs(CRS_UTM32)

    kant = lag_tarekant(hint)

    # Rutenett over kartområdet, med rad 0 øverst (nord)
    x0, y0, x1, y1 = (np.array(omrade.bounds) / RUTE_M).round() * RUTE_M
    kolonner, rader = int((x1 - x0) / RUTE_M), int((y1 - y0) / RUTE_M)
    transform = from_origin(x0, y1, RUTE_M, RUTE_M)
    form = (rader, kolonner)
    i_omradet = features.geometry_mask([omrade], form, transform, invert=True)
    pa_land = features.geometry_mask(land, form, transform, invert=True)
    i_sjoen = i_omradet & ~pa_land
    print(f"Rutenett {kolonner} × {rader} ruter à {RUTE_M} m, {i_sjoen.sum():,} i sjøen".replace(",", " "))

    dybde = lag_dybdeflate(rader, kolonner, transform, i_sjoen)
    gy, gx = np.gradient(dybde, RUTE_M)
    helning = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)

    # Verdiene som inngår i poengsummen
    dybdeverdi = np.minimum(rampe(dybde, DYBDE_M[0], DYBDE_M[1]), rampe(dybde, DYBDE_M[3], DYBDE_M[2]))
    helningsverdi = rampe(helning, *HELNING_GRADER)
    kantverdi = np.zeros(form, dtype=np.float32)
    for avstand, verdi in reversed(KANT_SONER_M):
        sone = features.geometry_mask(kant.buffer(avstand).values, form, transform, invert=True)
        kantverdi[sone] = verdi
    tareverdi = features.geometry_mask(hint.loc[hint["kategori"] == "hard"].geometry.values,
                                       form, transform, invert=True).astype(np.float32)
    poeng = dybdeverdi * (VEKT["helning"] * np.nan_to_num(helningsverdi)
                          + VEKT["kant"] * kantverdi + VEKT["tare"] * tareverdi)
    poeng = np.where(np.isnan(dybde), np.nan, poeng).astype(np.float32)

    gyldig = ~np.isnan(poeng)
    print(f"Ruter med dybde: {gyldig.sum():,}".replace(",", " "))
    print("Dybde:   " + "  ".join(f"{a}–{b} m {np.mean((dybde[gyldig] >= a) & (dybde[gyldig] < b)) * 100:.0f} %"
                                   for a, b in ((0, 5), (5, 10), (10, 30), (30, 40), (40, 999))))
    print("Helning: " + "  ".join(f"≥{g}° {np.mean(helning[gyldig] >= g) * 100:.1f} %" for g in (5, 10, 15, 20, 25, 35)))
    print("Poeng:   " + "  ".join(f"≥{g} {np.mean(poeng[gyldig] >= g) * 100:.1f} %" for g in (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7)))

    # Flater for hver klasse (adskilte, så de ikke tegnes oppå hverandre)
    klasse = np.zeros(form, dtype=np.uint8)
    klasse[poeng >= GRENSER["middels"]] = 1
    klasse[poeng >= GRENSER["hoy"]] = 2
    navn = {1: "middels", 2: "hoy"}
    flater = [{"klasse": navn[int(v)], "geometry": shapely.geometry.shape(g)}
              for g, v in features.shapes(klasse, mask=klasse > 0, transform=transform)]
    gdf = gpd.GeoDataFrame(flater, crs=CRS_UTM32).dissolve("klasse").reset_index().explode(ignore_index=True)
    gdf = gdf[gdf.area >= MINSTE_FLATE_M2].copy()
    # Mykere kanter enn trappetrinnene i rutenettet
    gdf["geometry"] = gdf.buffer(RUTE_M / 2, join_style="round").buffer(-RUTE_M / 2).simplify(FORENKLING_M)
    gdf = gdf[~gdf.is_empty & gdf.geom_type.isin(["Polygon", "MultiPolygon"])]
    for k in ("hoy", "middels"):
        del_ = gdf[gdf["klasse"] == k]
        print(f"  {k}: {len(del_)} flater, {del_.area.sum() / 1e6:.2f} km²")

    for sti, data in ((UT_FLATER, gdf[["klasse", "geometry"]]), (UT_KANT, kant)):
        sti.unlink(missing_ok=True)
        data.to_crs(CRS_WGS84).to_file(sti, driver="GeoJSON", engine="pyogrio",
                                       layer_options={"RFC7946": "YES", "COORDINATE_PRECISION": 5})
        print(f"Skrev {sti.name} ({sti.stat().st_size / 1e3:.0f} kB)")

    with rasterio.open(UT_RUTENETT, "w", driver="GTiff", width=kolonner, height=rader, count=3,
                       dtype="float32", crs=CRS_UTM32, transform=transform, nodata=np.nan,
                       compress="deflate", predictor=3) as tif:
        for i, (lag, beskrivelse) in enumerate(((dybde, "dybde"), (helning, "helning"), (poeng, "poeng")), 1):
            tif.write(np.where(i_sjoen, lag, np.nan).astype(np.float32), i)
            tif.set_band_description(i, beskrivelse)
    print(f"Skrev {UT_RUTENETT.relative_to(PROCESSED_DIR.parent.parent)} ({UT_RUTENETT.stat().st_size / 1e6:.1f} MB)")

    kilder_sti = APP_DATA_DIR / "kilder.json"
    kilder = json.loads(kilder_sti.read_text(encoding="utf-8")) if kilder_sti.exists() else {}
    kilder["hummerpotensial"] = {
        "navn": "Hummerpotensial og tarekant (anslag)",
        "kreditering": "Beregnet fra Kartverkets dybdedata og Miljødirektoratets marine naturtyper",
        "metode": "Dybde 10–30 m, helning, nærhet til kanten mellom tare og sand/ålegras, og tareskog",
        "laget": date.today().isoformat(),
    }
    kilder_sti.write_text(json.dumps(kilder, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())

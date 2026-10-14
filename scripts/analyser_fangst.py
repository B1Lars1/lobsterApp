"""Analyse av hummerfangst mot dybde og bunnhint.

Leser markeringene dine fra, i denne rekkefølgen:
  1. filen du oppgir:            python scripts/analyser_fangst.py sti/til/fil.geojson
  2. det klonede synk-repoet:    data/private/hummerkart-data/markeringer.geojson
  3. nyeste eksport fra appen:   data/private/markeringer-*.geojson

Fangst måles som hummer per teinedøgn: antall hummer (beholdt + satt ut) delt på
antall døgn teinene har stått i sjøen. Da teller også teiner uten fangst, og en teine
som har stått i tre døgn, veier mer enn en som ble tatt opp etter en time. Teiner som
fortsatt står i sjøen, regnes frem til nå.

Skriver tabeller i terminalen og filer til data/private/analyse/ (aldri i git):
  fangst.png            figurer: dybde, hver teinesetting, bunnhint og fangst per dag
  teinesettinger.csv    én rad per teinesetting (dybde, døgn, hummer, bunnhint, posisjon)

Kjør fra roten av repoet:  python scripts/analyser_fangst.py [fil] [--ut mappe]
"""

import argparse
import sys
from pathlib import Path

import geopandas as gpd
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")  # lag bildefiler uten å åpne vinduer
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.ticker as mticker  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402

from config import APP_DATA_DIR, PRIVATE_DIR  # noqa: E402

DYBDEGRENSER = [0, 5, 10, 15, 20, 30, np.inf]
DYBDENAVN = ["0–5", "5–10", "10–15", "15–20", "20–30", "30+"]
BUNNHINT = {"hard": "Tare\n(trolig fjell)", "blot": "Ålegras, skjellsand\n(trolig sand)"}
UKJENT_BUNN = "Ukjent\nbunn"
TIDSSONE = "Europe/Oslo"
FAA_TEINEDOGN = 30  # under dette: si tydelig fra at tallene er usikre

# Farger: én serie i blått, to serier i blått og oransje (sjekket for fargeblinde)
FLATE, TEKST, TEKST2, RUTENETT = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
BLAA, ORANSJE = "#2a78d6", "#eb6834"


def finn_fil(oppgitt: str | None) -> Path | None:
    if oppgitt:
        return Path(oppgitt)
    synk = PRIVATE_DIR / "hummerkart-data" / "markeringer.geojson"
    if synk.exists():
        return synk
    eksporter = sorted(PRIVATE_DIR.glob("markeringer-*.geojson"))
    return eksporter[-1] if eksporter else None


def les_markeringer(fil: Path) -> gpd.GeoDataFrame:
    m = gpd.read_file(fil)
    for kol in ("tid", "tatt_opp"):
        m[kol] = pd.to_datetime(m[kol], utc=True, format="ISO8601", errors="coerce")
    for kol in ("beholdt", "satt_ut", "dybde", "nummer"):
        m[kol] = pd.to_numeric(m[kol], errors="coerce")
    return m


def lag_teinesettinger(m: gpd.GeoDataFrame) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    """Én rad per teinesetting med døgn i sjøen og fangst. Returnerer også fangst uten teine."""
    fangst = m[m["kategori"] == "hummer"].copy()
    fangst["hummer"] = fangst["beholdt"].fillna(0) + fangst["satt_ut"].fillna(0)

    teiner = m[m["kategori"] == "teine"].copy()
    slutt = teiner["tatt_opp"].fillna(pd.Timestamp.now(tz="UTC"))
    teiner["doegn"] = ((slutt - teiner["tid"]).dt.total_seconds() / 86400).clip(lower=0)

    per_teine = fangst.groupby("teine_id")[["hummer", "beholdt", "satt_ut"]].sum()
    teiner = teiner.drop(columns=["beholdt", "satt_ut"]).join(per_teine, on="id")
    teiner[["hummer", "beholdt", "satt_ut"]] = teiner[["hummer", "beholdt", "satt_ut"]].fillna(0)
    teiner["per_doegn"] = teiner["hummer"] / teiner["doegn"].where(teiner["doegn"] > 0)
    teiner["dybdeintervall"] = pd.cut(teiner["dybde"], DYBDEGRENSER, labels=DYBDENAVN, right=False)

    # Bunnhint fra Miljødirektoratet (samme som i appen)
    hint = gpd.read_file(APP_DATA_DIR / "bunnhint.geojson")[["kategori", "geometry"]]
    treff = gpd.sjoin(teiner[["id", "geometry"]], hint, how="left", predicate="within")
    bunn = treff.drop_duplicates("id").set_index("id")["kategori"].map(BUNNHINT)
    teiner["bunn"] = teiner["id"].map(bunn).fillna(UKJENT_BUNN)

    uten_teine = fangst[~fangst["teine_id"].isin(teiner["id"])]
    return teiner, uten_teine


def oppsummer(teiner: pd.DataFrame, kolonne: str) -> pd.DataFrame:
    tabell = teiner.groupby(kolonne, observed=False).agg(
        settinger=("id", "count"),
        teinedoegn=("doegn", "sum"),
        hummer=("hummer", "sum"),
        beholdt=("beholdt", "sum"),
        satt_ut=("satt_ut", "sum"),
        med_fangst=("hummer", lambda s: int((s > 0).sum())),
    )
    tabell["per_teinedoegn"] = tabell["hummer"] / tabell["teinedoegn"].where(tabell["teinedoegn"] > 0)
    tabell[["hummer", "beholdt", "satt_ut"]] = tabell[["hummer", "beholdt", "satt_ut"]].astype(int)
    return tabell


def skriv_tabell(tittel: str, tabell: pd.DataFrame) -> None:
    print(f"\n{tittel}")
    vis = tabell.copy()
    vis.index = [str(i).replace("\n", " ") for i in vis.index]
    print(vis.to_string(float_format=lambda v: f"{v:.2f}".replace(".", ","), na_rep="–"))


# ---------- Figurer ----------

def stil(ax, tittel: str, xtekst: str = "", ytekst: str = "") -> None:
    ax.set_facecolor(FLATE)
    ax.set_title(tittel, loc="left", color=TEKST, fontsize=12, fontweight="bold", pad=10)
    ax.set_xlabel(xtekst, color=TEKST2)
    ax.set_ylabel(ytekst, color=TEKST2)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(RUTENETT)
    ax.tick_params(colors=TEKST2, length=0)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda v, _: f"{v:g}".replace(".", ",")))
    ax.grid(axis="y", color=RUTENETT, linewidth=0.8)
    ax.set_axisbelow(True)


def komma(v: float, desimaler: int = 2) -> str:
    return f"{v:.{desimaler}f}".replace(".", ",")


def stolper_per_teinedoegn(ax, tabell: pd.DataFrame, tittel: str) -> None:
    x = np.arange(len(tabell))
    verdier = tabell["per_teinedoegn"].fillna(0).values
    ax.bar(x, verdier, width=min(0.45, 0.045 * len(tabell)), color=BLAA)  # smale stolper, luft mellom
    ax.set_xlim(-0.5, len(tabell) - 0.5)  # ellers fyller én enkelt stolpe hele bredden
    for xi, v, n in zip(x, verdier, tabell["teinedoegn"]):
        if n > 0:
            ax.annotate(komma(v), (xi, v), xytext=(0, 4), textcoords="offset points",
                        ha="center", color=TEKST, fontsize=10)
    etiketter = [f"{navn}\n{komma(n, 1)} døgn" for navn, n in zip(tabell.index, tabell["teinedoegn"])]
    ax.set_xticks(x, etiketter, fontsize=9)
    stil(ax, tittel, ytekst="Hummer per teinedøgn")
    ax.set_ylim(0, max(verdier.max() * 1.25, 0.1))


def lag_figur(teiner, fangst_alle, dybdetabell, bunntabell, fil: Path, ut: Path) -> Path:
    fig, akser = plt.subplots(2, 2, figsize=(13, 9), facecolor=FLATE)
    (a, b), (c, d) = akser

    stolper_per_teinedoegn(a, dybdetabell, "Fangst etter dybde (m)")

    med = teiner.dropna(subset=["dybde", "per_doegn"])
    b.scatter(med["dybde"], med["per_doegn"], s=70, color=BLAA, edgecolors=FLATE, linewidths=1.5, zorder=3)
    stil(b, "Hver teinesetting", "Dybde (m)", "Hummer per døgn")
    b.set_xlim(left=0)
    b.set_ylim(bottom=0)

    stolper_per_teinedoegn(c, bunntabell, "Fangst etter bunnhint")

    if len(fangst_alle):
        dag = fangst_alle["tid"].dt.tz_convert(TIDSSONE).dt.date
        per_dag = fangst_alle.groupby(dag)[["beholdt", "satt_ut"]].sum()
        datoer = pd.to_datetime(per_dag.index)
        d.bar(datoer, per_dag["beholdt"], width=0.6, color=BLAA, edgecolor=FLATE, linewidth=1, label="Beholdt")
        d.bar(datoer, per_dag["satt_ut"], width=0.6, bottom=per_dag["beholdt"], color=ORANSJE,
              edgecolor=FLATE, linewidth=1, label="Satt ut")
        d.legend(frameon=False, labelcolor=TEKST, loc="upper left")
        # Minst en uke på aksen, så fangst fra én dag ikke blir en søyle over hele bredden,
        # og bare hele dager som merker (ellers gjentas samme dato).
        start, slutt = datoer.min() - pd.Timedelta(days=1), datoer.max() + pd.Timedelta(days=1)
        if slutt - start < pd.Timedelta(days=7):
            midt = start + (slutt - start) / 2
            start, slutt = midt - pd.Timedelta(days=3.5), midt + pd.Timedelta(days=3.5)
        d.set_xlim(start, slutt)
        d.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, (slutt - start).days // 7)))
        d.xaxis.set_major_formatter(mdates.DateFormatter("%d.%m."))
    stil(d, "Fangst per dag", ytekst="Antall hummer")
    d.yaxis.get_major_locator().set_params(integer=True)

    teinedoegn = teiner["doegn"].sum()
    tekst = (f"Kilde: {fil.name} · {len(teiner)} teinesettinger, {komma(teinedoegn, 1)} teinedøgn, "
             f"{int(fangst_alle['hummer'].sum())} hummer · Dybden er anslått fra Kartverkets dybdedata, "
             "bunnhint fra Miljødirektoratet.")
    if teinedoegn < FAA_TEINEDOGN:
        tekst += "  Få data: tolk forskjellene forsiktig."
    fig.text(0.01, 0.01, tekst, color=TEKST2, fontsize=9)
    fig.suptitle("Hummerfangst", x=0.01, ha="left", color=TEKST, fontsize=16, fontweight="bold")
    fig.tight_layout(rect=(0, 0.03, 1, 0.97))
    sti = ut / "fangst.png"
    fig.savefig(sti, dpi=120, facecolor=FLATE)
    plt.close(fig)
    return sti


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("fil", nargs="?", help="GeoJSON med markeringer (valgfri)")
    parser.add_argument("--ut", default=str(PRIVATE_DIR / "analyse"), help="mappe for figurer og CSV")
    args = parser.parse_args()

    fil = finn_fil(args.fil)
    if fil is None or not fil.exists():
        print("Fant ingen markeringer. Klon synk-repoet til data/private/hummerkart-data/ "
              "eller legg en eksport (markeringer-*.geojson) i data/private/. Se README.")
        return 1
    print(f"Leser {fil}")
    m = les_markeringer(fil)
    teiner, uten_teine = lag_teinesettinger(m)
    fangst_alle = m[m["kategori"] == "hummer"].assign(
        hummer=lambda f: f["beholdt"].fillna(0) + f["satt_ut"].fillna(0))
    if teiner.empty:
        print("Ingen teiner registrert ennå, så det er ingenting å regne fangst per teinedøgn på.")
        return 0

    dybdetabell = oppsummer(teiner, "dybdeintervall")
    bunntabell = oppsummer(teiner, "bunn").reindex([*BUNNHINT.values(), UKJENT_BUNN]).dropna(how="all")
    heltall = ["settinger", "hummer", "beholdt", "satt_ut", "med_fangst"]
    bunntabell[heltall] = bunntabell[heltall].astype(int)  # reindex gjør dem til desimaltall
    skriv_tabell("Fangst etter dybde (m):", dybdetabell)
    skriv_tabell("Fangst etter bunnhint:", bunntabell)
    if len(uten_teine):
        print(f"\n{int(uten_teine['hummer'].sum())} hummer er registrert uten kobling til en teine "
              "og er ikke med i «per teinedøgn».")
    if teiner["doegn"].sum() < FAA_TEINEDOGN:
        print(f"\nObs: bare {komma(teiner['doegn'].sum(), 1)} teinedøgn så langt. Tolk forskjellene forsiktig.")

    ut = Path(args.ut)
    ut.mkdir(parents=True, exist_ok=True)
    figur = lag_figur(teiner, fangst_alle, dybdetabell, bunntabell, fil, ut)

    csv = teiner.assign(
        lat=teiner.geometry.y.round(6), lon=teiner.geometry.x.round(6),
        bunn=teiner["bunn"].str.replace("\n", " "),
        nummer=teiner["nummer"].astype("Int64"),
        doegn=teiner["doegn"].round(2), per_doegn=teiner["per_doegn"].round(3),
        hummer=teiner["hummer"].astype(int), beholdt=teiner["beholdt"].astype(int),
        satt_ut=teiner["satt_ut"].astype(int),
    )
    kolonner = ["nummer", "tid", "tatt_opp", "status", "doegn", "dybde", "dybdeintervall", "bunn",
                "hummer", "beholdt", "satt_ut", "per_doegn", "lat", "lon", "notat"]
    csv[kolonner].sort_values("tid").to_csv(ut / "teinesettinger.csv", index=False, encoding="utf-8")
    print(f"\nSkrev {figur} og {ut / 'teinesettinger.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

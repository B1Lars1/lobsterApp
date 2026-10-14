"""Analyse av hummerfangst: tidslinje, statistikk, og fangst mot dybde og bunnhint.

Leser markeringene dine fra, i denne rekkefølgen:
  1. filen du oppgir:            python scripts/analyser_fangst.py sti/til/fil.geojson
  2. det klonede synk-repoet:    data/private/hummerkart-data/markeringer.geojson
  3. nyeste eksport fra appen:   data/private/markeringer-*.geojson

Fangst måles som hummer per teinedøgn: antall hummer (beholdt + satt ut) delt på
antall døgn teinene har stått i sjøen. Da teller også teiner uten fangst, og en teine
som har stått i tre døgn, veier mer enn en som ble tatt opp etter en time. Teiner som
fortsatt står i sjøen, regnes frem til nå.

Tidslinjen viser hver teinesetting fra den ble satt til den ble tatt opp (sjekket),
eller til nå hvis den står i sjøen, med hver fangstregistrering som en prikk.

Skriver tabeller i terminalen og filer til data/private/analyse/ (aldri i git):
  tidslinje.png         tidslinje for teinene, statistikk og teinesettinger med og uten hummer
  dybde_og_bunn.png     figurer: dybde, hver teinesetting, bunnhint og fangst per dag
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
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.patches import Patch  # noqa: E402

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
GRAA = "#b4b2a9"  # teinesettinger uten hummer


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


# ---------- Tidslinje og statistikk ----------

def lokal(tid: pd.Timestamp) -> pd.Timestamp:
    """Norsk tid uten tidssone (det matplotlib tegner)."""
    return tid.tz_convert(TIDSSONE).tz_localize(None)


def dnum(tid: pd.Timestamp) -> float:
    """Tidspunkt som tall på x-aksen (matplotlib sine datotall)."""
    return mdates.date2num(tid)


def klokke(tid: pd.Timestamp) -> str:
    return lokal(tid).strftime("%d.%m. %H:%M")


def prosent(del_: int, av: int) -> str:
    return f"{round(100 * del_ / av)} %" if av else "–"


def hummertekst(hummer: float, beholdt: float, satt_ut: float) -> str:
    if not hummer:
        return "ingen hummer"
    return f"{int(hummer)} hummer ({int(beholdt)} beholdt, {int(satt_ut)} satt ut)"


def lag_statistikk(teiner: pd.DataFrame, fangst_alle: pd.DataFrame, uten_teine: pd.DataFrame) -> list:
    """Summeringer som (etikett, verdi), til terminalen og figuren."""
    n = len(teiner)
    i_sjoen = teiner["tatt_opp"].isna()
    med = teiner["hummer"] > 0
    teinedoegn = teiner["doegn"].sum()
    sist = pd.concat([teiner["tatt_opp"], fangst_alle["tid"]]).max()
    slutt = "nå" if i_sjoen.any() else lokal(sist).strftime("%d.%m.%Y")
    linjer = [
        ("Periode", f"{lokal(teiner['tid'].min()).strftime('%d.%m.%Y')} – {slutt}"),
        ("Teinesettinger", f"{n} ({int(i_sjoen.sum())} i sjøen nå)"),
        ("Med hummer", f"{int(med.sum())} ({prosent(med.sum(), n)})"),
        ("Uten hummer", f"{int((~med).sum())} ({prosent((~med).sum(), n)})"),
        ("   tatt opp tomme", str(int((~med & ~i_sjoen).sum()))),
        ("   i sjøen, ingen ennå", str(int((~med & i_sjoen).sum()))),
        ("Hummer", hummertekst(fangst_alle["hummer"].sum(), fangst_alle["beholdt"].sum(),
                               fangst_alle["satt_ut"].sum())),
        ("Teinedøgn", komma(teinedoegn, 1)),
        ("Hummer per teinedøgn", komma(teiner["hummer"].sum() / teinedoegn) if teinedoegn > 0 else "–"),
        ("Døgn per setting (snitt)", komma(teinedoegn / n, 1)),
    ]
    if len(uten_teine):
        linjer.append(("Fangst uten teine", f"{int(uten_teine['hummer'].sum())} hummer (ikke med i snittet)"))
    if med.any():
        beste = teiner.loc[teiner["hummer"].idxmax()]
        dybde = f", ca. {beste['dybde']:.0f} m" if pd.notna(beste["dybde"]) else ""
        linjer.append(("Beste setting", f"teine {beste['nummer']:.0f} ({lokal(beste['tid']).strftime('%d.%m.')}), "
                                        f"{int(beste['hummer'])} hummer{dybde}"))
    return linjer


def skriv_tidslinje(teiner: pd.DataFrame, fangst_alle: pd.DataFrame) -> None:
    print("\nTidslinje:")
    for _, t in teiner.sort_values("tid").iterrows():
        slutt = f"tatt opp {klokke(t['tatt_opp'])}" if pd.notna(t["tatt_opp"]) else "i sjøen nå"
        print(f"  Teine {t['nummer']:>2.0f}  satt {klokke(t['tid'])} → {slutt} ({komma(t['doegn'], 1)} døgn): "
              f"{hummertekst(t['hummer'], t['beholdt'], t['satt_ut'])}")
        for f in fangst_alle[fangst_alle["teine_id"] == t["id"]].sort_values("tid").itertuples():
            print(f"              fangst {klokke(f.tid)}: {hummertekst(f.hummer, f.beholdt, f.satt_ut)}")


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
    fig.suptitle("Fangst mot dybde og bunn", x=0.01, ha="left", color=TEKST, fontsize=16, fontweight="bold")
    fig.tight_layout(rect=(0, 0.03, 1, 0.97))
    sti = ut / "dybde_og_bunn.png"
    fig.savefig(sti, dpi=120, facecolor=FLATE)
    plt.close(fig)
    return sti


def tegn_tidslinje(ax, teiner: pd.DataFrame, fangst_alle: pd.DataFrame, uten_teine: pd.DataFrame) -> None:
    """Én rad per teinenummer. Stolpe fra satt til tatt opp (eller nå), prikk for hver fangst."""
    naa = lokal(pd.Timestamp.now(tz="UTC"))
    nummer = sorted(teiner["nummer"].fillna(0).astype(int).unique())
    rad = {nr: i for i, nr in enumerate(nummer)}
    navn = [f"Teine {nr}" if nr else "Teine ?" for nr in nummer]
    if len(uten_teine):
        navn.append("Uten teine")
    rad_for_teine = {t.id: rad[int(0 if pd.isna(t.nummer) else t.nummer)] for t in teiner.itertuples()}

    tider = [naa] if teiner["tatt_opp"].isna().any() else []
    for t in teiner.itertuples():
        start = lokal(t.tid)
        tatt_opp = pd.notna(t.tatt_opp)
        slutt = lokal(t.tatt_opp) if tatt_opp else naa
        tider += [start, slutt]
        farge = BLAA if t.hummer > 0 else GRAA
        y = rad_for_teine[t.id]
        ax.barh(y, (slutt - start) / pd.Timedelta(days=1), left=dnum(start), height=0.42,
                color=farge, alpha=1 if tatt_opp else 0.45, edgecolor=farge, linewidth=1.2, zorder=2)
        ax.plot(dnum(start), y, marker="|", color=TEKST, markersize=16, mew=2.2, zorder=3)  # satt
        if tatt_opp:
            ax.plot(dnum(slutt), y, marker="s", color=TEKST, markersize=7, zorder=3)  # tatt opp (sjekket)
        else:
            ax.plot(dnum(slutt), y, marker=">", color=farge, markersize=9, zorder=3)  # står i sjøen

    for f in fangst_alle.itertuples():
        y = rad_for_teine.get(f.teine_id, len(nummer))  # uten teine: nederste rad
        x = lokal(f.tid)
        tider.append(x)
        ax.scatter(dnum(x), y, s=170 + 45 * min(f.hummer, 6), color=ORANSJE if f.hummer else GRAA,
                   edgecolors=FLATE, linewidths=1.5, zorder=4)
        ax.annotate(f"{f.hummer:.0f}", (dnum(x), y), ha="center", va="center", color="white",
                    fontsize=9, fontweight="bold", zorder=5)

    t0, t1 = min(tider), max(tider)
    luft = max((t1 - t0) * 0.04, pd.Timedelta(hours=3))
    ax.set_xlim(dnum(t0 - luft), dnum(t1 + luft))
    ax.set_yticks(range(len(navn)), navn)
    ax.set_ylim(len(navn) - 0.5, -0.7)  # første teine øverst
    if teiner["tatt_opp"].isna().any():
        ax.axvline(dnum(naa), color=TEKST2, linestyle=(0, (3, 3)), linewidth=1, zorder=1)
        ax.annotate("nå", (dnum(naa), -0.7), xytext=(3, -2), textcoords="offset points", va="top",
                    color=TEKST2, fontsize=9)
    ax.xaxis_date()
    ax.xaxis.set_major_locator(mdates.AutoDateLocator(minticks=4, maxticks=10))
    kort = (t1 - t0) < pd.Timedelta(days=3)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d.%m.\n%H:%M" if kort else "%d.%m."))

    ax.set_facecolor(FLATE)
    ax.set_title("Tidslinje", loc="left", color=TEKST, fontsize=12, fontweight="bold", pad=10)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(RUTENETT)
    ax.tick_params(colors=TEKST2, length=0)
    ax.grid(axis="x", color=RUTENETT, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.legend(handles=[
        Patch(color=BLAA, label="Teinesetting med hummer"),
        Patch(color=GRAA, label="uten hummer"),
        Patch(color=GRAA, alpha=0.45, label="står i sjøen nå"),
        Line2D([], [], color=TEKST, marker="|", markersize=12, mew=2, linestyle="", label="satt"),
        Line2D([], [], color=TEKST, marker="s", markersize=6, linestyle="", label="tatt opp"),
        Line2D([], [], color=ORANSJE, marker="o", markersize=10, linestyle="", label="fangst (antall hummer)"),
    ], frameon=False, labelcolor=TEKST, fontsize=9, ncol=6, loc="upper left", bbox_to_anchor=(0, -0.12))


def tegn_statistikk(ax, statistikk: list) -> None:
    ax.axis("off")
    ax.set_title("Statistikk", loc="left", color=TEKST, fontsize=12, fontweight="bold", pad=10)
    for i, (etikett, verdi) in enumerate(statistikk):
        y = 1 - (i + 0.5) / max(len(statistikk), 10)
        ax.text(0, y, etikett, transform=ax.transAxes, color=TEKST2, fontsize=10.5, va="center")
        ax.text(0.36, y, verdi, transform=ax.transAxes, color=TEKST, fontsize=10.5, fontweight="bold",
                va="center")


def tegn_med_og_uten(ax, teiner: pd.DataFrame) -> None:
    i_sjoen = teiner["tatt_opp"].isna()
    med = teiner["hummer"] > 0
    rader = [("Med hummer", int(med.sum()), BLAA, 1),
             ("Tatt opp uten hummer", int((~med & ~i_sjoen).sum()), GRAA, 1),
             ("I sjøen, ingen ennå", int((~med & i_sjoen).sum()), GRAA, 0.45)]
    for y, (_, antall, farge, alfa) in enumerate(rader):
        ax.barh(y, antall, height=0.5, color=farge, alpha=alfa)
        ax.annotate(str(antall), (antall, y), xytext=(5, 0), textcoords="offset points", va="center",
                    color=TEKST, fontsize=11, fontweight="bold")
    ax.set_yticks(range(len(rader)), [r[0] for r in rader])
    ax.set_ylim(len(rader) - 0.5, -0.5)
    ax.set_xlim(0, max(max(r[1] for r in rader) * 1.2, 1))
    ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
    ax.set_facecolor(FLATE)
    ax.set_title("Teinesettinger med og uten hummer", loc="left", color=TEKST, fontsize=12,
                 fontweight="bold", pad=10)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(RUTENETT)
    ax.tick_params(colors=TEKST2, length=0)
    ax.grid(axis="x", color=RUTENETT, linewidth=0.8)
    ax.set_axisbelow(True)


def lag_tidslinje(teiner, fangst_alle, uten_teine, statistikk: list, fil: Path, ut: Path) -> Path:
    fig = plt.figure(figsize=(13, 9.5), facecolor=FLATE)
    rutenett = fig.add_gridspec(2, 2, height_ratios=[3, 2], width_ratios=[1.45, 1], hspace=0.45, wspace=0.32)
    tegn_tidslinje(fig.add_subplot(rutenett[0, :]), teiner, fangst_alle, uten_teine)
    tegn_statistikk(fig.add_subplot(rutenett[1, 0]), statistikk)
    tegn_med_og_uten(fig.add_subplot(rutenett[1, 1]), teiner)
    tekst = (f"Kilde: {fil.name} · Tidene er norsk tid. En teine som sjekkes og settes rett ut igjen "
             "uten å registreres som tatt opp, vises som én lang setting.")
    if teiner["doegn"].sum() < FAA_TEINEDOGN:
        tekst += "  Få data: tolk tallene forsiktig."
    fig.text(0.01, 0.01, tekst, color=TEKST2, fontsize=9)
    fig.suptitle("Hummerfangst", x=0.01, ha="left", color=TEKST, fontsize=16, fontweight="bold")
    fig.subplots_adjust(left=0.08, right=0.98, top=0.91, bottom=0.07)
    sti = ut / "tidslinje.png"
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

    statistikk = lag_statistikk(teiner, fangst_alle, uten_teine)
    print("\nStatistikk:")
    for etikett, verdi in statistikk:
        print(f"  {etikett + ':':<27}{verdi}")
    skriv_tidslinje(teiner, fangst_alle)

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
    tidslinje = lag_tidslinje(teiner, fangst_alle, uten_teine, statistikk, fil, ut)
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
    print(f"\nSkrev {tidslinje}, {figur} og {ut / 'teinesettinger.csv'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

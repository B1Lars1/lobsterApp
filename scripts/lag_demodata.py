"""Lag oppdiktede teiner og fangst til en demokonto, så appen kan vises fram uten ekte data.

Skriptet lager flere hummersesonger for én person som fisker med 10 teiner rundt Skauerøya:
teinene settes 1. oktober kl. 08, trekkes hver eller annenhver dag, flyttes når de står tomt,
og tas opp mot slutten av november. Tidlig i hver sesong mistes en teine, og noen ganger blir det tatt
en hummer på dykk (fangst uten teine). Plassene trekkes tilfeldig i områdene med høyt og
middels hummerpotensial (app/data/hummerpotensial.geojson), utenfor fredningsområdene, og
fangsten trekkes ut fra potensialet og en tilfeldig «kvalitet» for hver plass. Ingenting
bygger på ekte fangst.

Les filen inn med «Gjenopprett fra fil» (nederst i innstillingene) mens du er logget inn på
demokontoen. Appen sender den til kontoen, og alle telefoner som logger inn der, får den.

Samme frø gir de samme markeringene (samme id-er) hver gang. Hele sesongen regnes ut, og
alt etter --naa (standard: nå) kuttes bort. Kjør skriptet på nytt senere i sesongen og les
inn filen igjen, så fylles sesongen på fram til i dag: teinene som sto i sjøen, blir tatt
opp (nyere «endret» vinner), det som er nytt, legges til, og resten er uendret.

Kjør fra roten av repoet (virker med alle Python 3, uten ekstra pakker):
  python scripts/lag_demodata.py --uid BRUKER-ID [--ut fil] [--naa 2026-10-16T12:00] [--fro demo]

BRUKER-ID er demokontoens User UID (Firebase-konsollen → Authentication → Users). Uten
--uid blir eieren tom, som for markeringer registrert uten konto. Det går fint så lenge
demokontoen ikke er med i et lag (i et lag blir teinene da «Ukjent»).
"""

from __future__ import annotations

import argparse
import json
import math
import random
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from config import APP_DATA_DIR, PRIVATE_DIR

# Feltene i rekkefølgen appen bruker (FELT i app/js/markeringer.js)
FELT = [
    "id", "kategori", "tid", "endret", "notat", "dybde", "noyaktighet", "kilde",
    "nummer", "status", "tatt_opp", "beholdt", "satt_ut", "teine_id", "registrert_av", "mistet",
]

SENTER = (58.2339, 8.3835)  # START i app/js/app.js (Skauerøya)
RADIUS_M = 3000             # plassene ligger innenfor denne avstanden fra SENTER
ANTALL_PLASSER = 18         # flere plasser enn teiner, så teinene kan flyttes
ANTALL_TEINER = 10          # det en fritidsfisker kan bruke
ANTALL_SESONGER = 3         # sesongen som pågår (eller den siste) og de to før

# Forventet antall hummer i en teine som har stått ett døgn tidlig i sesongen, etter klassen
# der den står. Over sesongen gir det omtrent FORVENTET i potensialjustering.js per teinedøgn.
GRUNNRATE = {"hoy": 0.6, "middels": 0.36}
ANDEL_BEHOLDT = 0.38       # resten er under minstemålet eller rognhummer
SJANSE_FLYTT = 0.1         # flytter teinen selv om den ga hummer
SJANSE_DYKK = 0.04         # per tur: en hummer tatt på dykk (fangst uten teine)

NOTAT_TEINE = ["Agn: makrell", "Agn: sild", "Agn: fiskeavskjær", "Brattkant ved holmen",
               "Ny plass, prøver her", "Blå blåse"]
NOTAT_SATT_UT = ["Rognhummer, satt ut igjen", "Under minstemål", "Rognhummer"]
NOTAT_BEHOLDT = ["Fin hummer, ca. 29 cm", "Stor en!", "Mistet en klo", "Akkurat over minstemål"]
NOTAT_TOM = ["Bare krabbe", "Agnet borte", "Leppefisk og krabbe", "Teina hadde veltet"]

M_PER_GRAD = 111_320
REGISTRERING = timedelta(seconds=60)  # et trekk regnes som gjort når fangsten er registrert


# ---------- Geometri (uten GeoPandas, så skriptet virker med alle Python 3) ----------

def flytt(lat: float, lon: float, nord_m: float, ost_m: float) -> tuple[float, float]:
    return (lat + nord_m / M_PER_GRAD,
            lon + ost_m / (M_PER_GRAD * math.cos(math.radians(lat))))


def avstand_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * M_PER_GRAD,
                      (a[1] - b[1]) * M_PER_GRAD * math.cos(math.radians(a[0])))


def i_ring(lon: float, lat: float, ring: list) -> bool:
    inne = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inne = not inne
        j = i
    return inne


class Flate:
    """Et polygon (ytre ring og hull, [lon, lat]) med klassen fra hummerpotensialet."""

    def __init__(self, ringer: list, klasse: str | None = None):
        self.ringer = ringer
        self.klasse = klasse
        xs = [p[0] for p in ringer[0]]
        ys = [p[1] for p in ringer[0]]
        self.boks = (min(xs), min(ys), max(xs), max(ys))
        self.midt = ((self.boks[1] + self.boks[3]) / 2, (self.boks[0] + self.boks[2]) / 2)
        # Areal i m² (skolisseformelen, hull trukket fra)
        kx = M_PER_GRAD * math.cos(math.radians(self.midt[0]))
        self.areal = 0.0
        for k, ring in enumerate(ringer):
            a = sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))
            self.areal += abs(a) / 2 * kx * M_PER_GRAD * (1 if k == 0 else -1)

    def inneholder(self, lat: float, lon: float) -> bool:
        x0, y0, x1, y1 = self.boks
        if not (x0 <= lon <= x1 and y0 <= lat <= y1):
            return False
        return sum(i_ring(lon, lat, r) for r in self.ringer) % 2 == 1


def les_flater(fil, med_klasse: bool) -> list[Flate]:
    flater = []
    for f in json.loads(fil.read_text(encoding="utf-8"))["features"]:
        g = f["geometry"]
        polygoner = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for ringer in polygoner:
            flater.append(Flate(ringer, f["properties"].get("klasse") if med_klasse else None))
    return flater


class Kart:
    """Hummerpotensialet og fredningsområdene rundt SENTER."""

    def __init__(self):
        alle = les_flater(APP_DATA_DIR / "hummerpotensial.geojson", med_klasse=True)
        self.potensial = [f for f in alle if avstand_m(f.midt, SENTER) < RADIUS_M + 500]
        self.fredning = les_flater(APP_DATA_DIR / "fredningsomrader.geojson", med_klasse=False)

    def klasse(self, lat: float, lon: float) -> str | None:
        """Klassen i punktet ('hoy' eller 'middels'), eller None (lav, land eller fredning)."""
        if any(f.inneholder(lat, lon) for f in self.fredning):
            return None
        for f in self.potensial:
            if f.inneholder(lat, lon):
                return f.klasse
        return None


class Plass:
    def __init__(self, lat: float, lon: float, klasse: str, kvalitet: float):
        self.lat, self.lon, self.klasse, self.kvalitet = lat, lon, klasse, kvalitet


def velg_plasser(kart: Kart, rng: random.Random) -> list[Plass]:
    """Fiskeplassene, de samme hver sesong. Høyt potensial er mer fristende enn middels."""
    flater = [f for f in kart.potensial if avstand_m(f.midt, SENTER) < RADIUS_M and f.areal > 300]
    vekter = [f.areal * (2.5 if f.klasse == "hoy" else 1) for f in flater]
    plasser = []
    for _ in range(5000):
        if len(plasser) == ANTALL_PLASSER:
            break
        flate = velg_vektet(rng, flater, vekter)
        x0, y0, x1, y1 = flate.boks
        lat, lon = y0 + rng.random() * (y1 - y0), x0 + rng.random() * (x1 - x0)
        klasse = kart.klasse(lat, lon)
        if klasse is None or any(avstand_m((lat, lon), (p.lat, p.lon)) < 150 for p in plasser):
            continue
        # Noen plasser er bedre enn modellen tror, andre dårligere
        plasser.append(Plass(lat, lon, klasse, math.exp(rng.gauss(0, 0.5))))
    if len(plasser) < ANTALL_PLASSER:
        raise SystemExit("Fant ikke nok plasser med hummerpotensial rundt SENTER")
    return plasser


def punkt_ved(kart: Kart, rng: random.Random, plass: Plass, maks_m: float = 25):
    """Et punkt nær plassen (GPS-en der båten ligger), med klassen der."""
    for _ in range(30):
        r, vinkel = maks_m * math.sqrt(rng.random()), 2 * math.pi * rng.random()
        lat, lon = flytt(plass.lat, plass.lon, r * math.cos(vinkel), r * math.sin(vinkel))
        klasse = kart.klasse(lat, lon)
        if klasse:
            return lat, lon, klasse
    return plass.lat, plass.lon, plass.klasse


# ---------- Tilfeldige tall (bare random() og gauss(), som er like i alle Python-versjoner) ----------

def velg(rng: random.Random, liste: list):
    return liste[int(rng.random() * len(liste))]


def velg_vektet(rng: random.Random, liste: list, vekter: list[float]):
    x = rng.random() * sum(vekter)
    for element, vekt in zip(liste, vekter):
        x -= vekt
        if x < 0:
            return element
    return liste[-1]


def poisson(rng: random.Random, forventet: float) -> int:
    grense, k, p = math.exp(-forventet), 0, rng.random()
    while p > grense:
        k += 1
        p *= rng.random()
    return k


# ---------- Tid ----------

def siste_sondag(aar: int, maaned: int) -> date:
    d = date(aar, maaned + 1, 1) - timedelta(days=1)  # brukes for mars og oktober
    return d - timedelta(days=(d.weekday() + 1) % 7)


def norsk_tid(aar: int, maaned: int, dag: int, timer: float) -> datetime:
    """Norsk lokaltid → UTC (sommertid til siste søndag i oktober)."""
    sommer = date(aar, maaned, dag) < siste_sondag(aar, 10) and date(aar, maaned, dag) >= siste_sondag(aar, 3)
    lokal = datetime(aar, maaned, dag, tzinfo=timezone.utc) + timedelta(hours=timer)
    return lokal - timedelta(hours=2 if sommer else 1)


def iso(t: datetime) -> str:
    """Samme format som Date.toISOString() i appen (tidene sammenlignes som tekst)."""
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def hummersesong(naa: datetime) -> int:
    lokal = naa + timedelta(hours=2)
    return lokal.year if lokal.month >= 10 else lokal.year - 1


# ---------- Simuleringen ----------

class Sesong:
    """Én sesong for én person, fra 1. oktober til teinene tas opp i slutten av november."""

    def __init__(self, aar: int, kart: Kart, plasser: list[Plass], fro: str, uid: str | None):
        self.aar, self.kart, self.plasser, self.uid = aar, kart, plasser, uid
        self.rng = random.Random(f"{fro}/{aar}")
        self.fro = fro
        self.lopenummer = 0
        self.markeringer = []  # (tidspunktet den finnes fra, markering)
        self.aarsfaktor = math.exp(self.rng.gauss(0, 0.12))

    def _id(self) -> str:
        self.lopenummer += 1
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"hummerkart-demo/{self.fro}/{self.aar}/{self.lopenummer}"))

    def _gps(self) -> tuple[str, int | None]:
        return ("kart", None) if self.rng.random() < 0.1 else ("gps", round(3 + self.rng.random() * 11))

    def _sett(self, tid: datetime, nummer: int, plass: Plass, notat: str = "") -> dict:
        lat, lon, klasse = punkt_ved(self.kart, self.rng, plass)
        kilde, noyaktighet = self._gps()
        teine = {
            "id": self._id(), "kategori": "teine", "tid": iso(tid), "endret": iso(tid), "notat": notat,
            "dybde": None, "noyaktighet": noyaktighet, "kilde": kilde, "nummer": nummer,
            "status": "i_sjoen", "tatt_opp": None, "beholdt": None, "satt_ut": None, "teine_id": None,
            "registrert_av": self.uid, "mistet": False, "lat": round(lat, 6), "lon": round(lon, 6),
            "_plass": plass, "_klasse": klasse, "_satt": tid, "_opp": None,
        }
        self.markeringer.append((tid, teine))
        return teine

    def _fangst(self, tid: datetime, teine: dict | None, beholdt: int, satt_ut: int, notat: str,
                posisjon: tuple | None = None) -> None:
        kilde, noyaktighet = (teine["kilde"], teine["noyaktighet"]) if teine else self._gps()
        lat, lon = (teine["lat"], teine["lon"]) if teine else posisjon
        self.markeringer.append((tid + REGISTRERING, {
            "id": self._id(), "kategori": "hummer", "tid": iso(tid), "endret": iso(tid + timedelta(seconds=40)),
            "notat": notat, "dybde": None, "noyaktighet": noyaktighet, "kilde": kilde, "nummer": None,
            "status": None, "tatt_opp": None, "beholdt": beholdt, "satt_ut": satt_ut,
            "teine_id": teine["id"] if teine else None, "registrert_av": self.uid, "mistet": None,
            "lat": round(lat, 6), "lon": round(lon, 6),
        }))

    def _turdager(self) -> list[date]:
        """Dagene båten er ute: nesten hver dag den første uka, så hver 1.–3. dag, og pauser for uvær."""
        rng = self.rng
        siste = date(self.aar, 11, 18 + int(rng.random() * 13))  # tar opp alt mellom 18. og 30. november
        dager = [date(self.aar, 10, 1)]
        while dager[-1] < siste:
            dag_nr = (dager[-1] - dager[0]).days
            if dag_nr < 8:
                pause = 1 if rng.random() < 0.75 else 2
            else:
                pause = velg_vektet(rng, [1, 2, 3, 4], [0.35, 0.4, 0.2, 0.05])
            if rng.random() < 0.06:
                pause += 2 + int(rng.random() * 2)  # uvær
            dager.append(min(dager[-1] + timedelta(days=pause), siste))
        return dager

    def simuler(self) -> None:
        rng = self.rng
        dager = self._turdager()
        start = dager[0]
        # Én teine mistes tidlig i sesongen (så det også skjer i sesongen som pågår)
        mistet = (dager[3 + int(rng.random() * 6)], 1 + int(rng.random() * ANTALL_TEINER))
        i_sjoen: dict[int, dict] = {}
        tomme = {n: 0 for n in range(1, ANTALL_TEINER + 1)}

        def ledig_plass() -> Plass:
            opptatt = {id(t["_plass"]) for t in i_sjoen.values()}
            return velg(rng, [p for p in self.plasser if id(p) not in opptatt])

        for dag in dager:
            dag_nr = (dag - start).days
            if dag_nr == 0:
                # Fisket starter 1. oktober kl. 08: alle teinene settes
                tid = norsk_tid(dag.year, dag.month, dag.day, 8 + rng.random() * 0.2)
                for nummer in range(1, ANTALL_TEINER + 1):
                    notat = "Agn: makrell" if rng.random() < 0.3 else ""
                    i_sjoen[nummer] = self._sett(tid, nummer, ledig_plass(), notat)
                    tid += timedelta(seconds=240 + rng.random() * 300)
                continue

            helg = dag.weekday() >= 5
            tid = norsk_tid(dag.year, dag.month, dag.day, (9 if helg else 13.5) + rng.random() * 2.5)
            siste_tur = dag == dager[-1]
            sesongfaktor = 0.6 + math.exp(-dag_nr / 12)  # mest hummer de første ukene
            for nummer in sorted(i_sjoen):
                teine = i_sjoen.pop(nummer)
                plass = teine["_plass"]
                if (dag, nummer) == mistet:
                    # Finner ikke blåsen: meldt mistet, og en reserveteine settes med samme nummer
                    teine.update(status="tatt_opp", tatt_opp=iso(tid), mistet=True,
                                 endret=iso(tid + timedelta(seconds=20)), _opp=tid)
                    i_sjoen[nummer] = self._sett(tid + timedelta(seconds=120), nummer, ledig_plass(),
                                                 "Reserveteine")
                    tid += timedelta(seconds=300 + rng.random() * 300)
                    continue

                dogn = (tid - teine["_satt"]).total_seconds() / 86400
                forventet = (GRUNNRATE[teine["_klasse"]] * 1.6 * (1 - math.exp(-dogn / 1.6))
                             * sesongfaktor * plass.kvalitet * self.aarsfaktor)
                hummer = poisson(rng, forventet)
                beholdt = sum(rng.random() < ANDEL_BEHOLDT for _ in range(hummer))
                satt_ut = hummer - beholdt
                if satt_ut and rng.random() < 0.25:
                    notat = velg(rng, NOTAT_SATT_UT)
                elif beholdt and rng.random() < 0.15:
                    notat = velg(rng, NOTAT_BEHOLDT)
                elif not hummer and rng.random() < 0.06:
                    notat = velg(rng, NOTAT_TOM)
                else:
                    notat = ""
                self._fangst(tid, teine, beholdt, satt_ut, notat)
                # Fangst fra en teine i sjøen betyr at den er tatt opp (som i appen)
                teine.update(status="tatt_opp", tatt_opp=iso(tid), endret=iso(tid + timedelta(seconds=41)), _opp=tid)

                if not siste_tur:
                    tomme[nummer] = 0 if hummer else tomme[nummer] + 1
                    if (tomme[nummer] >= 2 and rng.random() < 0.7) or rng.random() < SJANSE_FLYTT:
                        tomme[nummer] = 0
                        ny_plass, notat = ledig_plass(), velg(rng, NOTAT_TEINE) if rng.random() < 0.15 else ""
                    else:
                        ny_plass, notat = plass, ""
                    i_sjoen[nummer] = self._sett(tid + timedelta(seconds=60 + rng.random() * 120),
                                                 nummer, ny_plass, notat)
                tid += timedelta(seconds=240 + rng.random() * 300)

            if not siste_tur and rng.random() < SJANSE_DYKK:
                plass = velg(rng, [p for p in self.plasser if p.klasse == "hoy"] or self.plasser)
                lat, lon, _ = punkt_ved(self.kart, rng, plass, maks_m=80)
                self._fangst(tid + timedelta(minutes=30), None, 1, int(rng.random() < 0.4), "Tatt på dykk",
                             (lat, lon))

    def markeringer_til(self, naa: datetime) -> list[dict]:
        """Det som har skjedd innen naa. Teiner som tas opp senere, står i sjøen."""
        ut = []
        for fra, m in self.markeringer:
            if fra > naa:
                continue
            m = dict(m)
            if m["kategori"] == "teine" and m["_opp"] and m["_opp"] + REGISTRERING > naa:
                m.update(status="i_sjoen", tatt_opp=None, mistet=False, endret=m["tid"])
            ut.append({k: v for k, v in m.items() if not k.startswith("_")})
        return ut


def som_geojson(markeringer: list[dict]) -> str:
    """Én markering per linje, i samme format som sikkerhetskopien."""
    linjer = []
    for m in sorted(markeringer, key=lambda m: (m["tid"], m["kategori"] == "teine")):
        egenskaper = {f: m[f] for f in FELT}
        linjer.append(json.dumps({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [m["lon"], m["lat"]]},
            "properties": egenskaper,
        }, ensure_ascii=False))
    return '{"type": "FeatureCollection", "features": [\n' + ",\n".join(linjer) + "\n]}\n"


def statistikk(aar: int, markeringer: list[dict], naa: datetime) -> str:
    teiner = [m for m in markeringer if m["kategori"] == "teine"]
    fangst = [m for m in markeringer if m["kategori"] == "hummer"]
    mistet = sum(1 for t in teiner if t["mistet"])
    dogn = sum(((datetime.fromisoformat(t["tatt_opp"].replace("Z", "+00:00")) if t["tatt_opp"] else naa)
                - datetime.fromisoformat(t["tid"].replace("Z", "+00:00"))).total_seconds() / 86400
               for t in teiner if not t["mistet"])
    beholdt = sum(f["beholdt"] for f in fangst)
    satt_ut = sum(f["satt_ut"] for f in fangst)
    fra_teiner = sum(f["beholdt"] + f["satt_ut"] for f in fangst if f["teine_id"])
    i_sjoen = sum(1 for t in teiner if t["status"] == "i_sjoen")
    rate = f"{fra_teiner / dogn:.2f}".replace(".", ",") if dogn else "–"
    return (f"  {aar}: {len(teiner)} teinesettinger ({i_sjoen} i sjøen, {mistet} mistet), "
            f"{len(fangst)} fangstregistreringer, {beholdt} beholdt og {satt_ut} satt ut, "
            f"{rate} hummer per teinedøgn")


def main() -> None:
    parser = argparse.ArgumentParser(description="Lag oppdiktede teiner og fangst til en demokonto.")
    parser.add_argument("--uid", help="demokontoens bruker-id (User UID i Firebase), eieren av teinene")
    parser.add_argument("--ut", default=str(PRIVATE_DIR / "demodata.geojson"), help="filen som lages")
    parser.add_argument("--naa", help="lag data fram til dette tidspunktet (UTC, for eksempel 2026-10-16T12:00)")
    parser.add_argument("--fro", default="demo", help="frø: et annet frø gir andre plasser og annen fangst")
    args = parser.parse_args()

    naa = datetime.fromisoformat(args.naa.rstrip("Z")) if args.naa else datetime.now(timezone.utc)
    naa = naa.replace(tzinfo=timezone.utc) if naa.tzinfo is None else naa.astimezone(timezone.utc)
    kart = Kart()
    plasser = velg_plasser(kart, random.Random(f"{args.fro}/plasser"))

    alle = []
    print(f"Oppdiktede teiner og fangst fram til {naa:%d.%m.%Y %H:%M} UTC:")
    siste = hummersesong(naa)
    for aar in range(siste - ANTALL_SESONGER + 1, siste + 1):
        sesong = Sesong(aar, kart, plasser, args.fro, args.uid)
        sesong.simuler()
        markeringer = sesong.markeringer_til(naa)
        alle += markeringer
        print(statistikk(aar, markeringer, naa))

    ut = Path(args.ut)
    ut.parent.mkdir(parents=True, exist_ok=True)
    ut.write_text(som_geojson(alle), encoding="utf-8", newline="\n")
    print(f"{len(alle)} markeringer skrevet til {ut}")
    print("Logg inn på demokontoen i appen, og les filen inn med «Gjenopprett fra fil» i innstillingene.")
    if not args.uid:
        print("Uten --uid er teinene uten eier. Det går fint så lenge demokontoen ikke er med i et lag.")


if __name__ == "__main__":
    main()

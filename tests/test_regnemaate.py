"""Analysen (scripts/analyser_fangst.py) regner som fasiten i fangst_fasit.json.

Fangstoversikten i appen testes mot den samme fasiten (regnemaate.test.mjs), så de to
ikke kan gli fra hverandre uten at det merkes. Krever Python-miljøet fra requirements.txt.

Kjør fra roten av repoet:  python -m unittest discover -s tests
"""

import json
import math
import sys
import unittest
from pathlib import Path

MAPPE = Path(__file__).resolve().parent
sys.path.insert(0, str(MAPPE.parent / "scripts"))

import analyser_fangst as af  # noqa: E402


class TestRegnemaate(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fasit = json.loads((MAPPE / "fangst_fasit.json").read_text(encoding="utf-8"))
        m = af.les_markeringer(MAPPE / "fangst_testdata.geojson")
        alle_teiner, _ = af.lag_teinesettinger(m)
        cls.alle_teiner = alle_teiner
        cls.teiner = alle_teiner[~alle_teiner["mistet"]]
        cls.fangst = m[m["kategori"] == "hummer"].assign(
            hummer=lambda f: f["beholdt"].fillna(0) + f["satt_ut"].fillna(0))

    def sammenlign(self, navn, faktisk, forventet):
        for felt, verdi in forventet.items():
            with self.subTest(navn=navn, felt=felt):
                self.assertTrue(math.isclose(faktisk[felt], verdi, abs_tol=1e-9),
                                f"{navn}: {felt} er {faktisk[felt]}, ventet {verdi}")

    def tall(self, eier=None):
        """Samme tall som lag_statistikk() og per_person(), for alle eller én eier."""
        alle = self.alle_teiner if eier is None else self.alle_teiner[self.alle_teiner["eier"] == eier]
        teiner = alle[~alle["mistet"]]
        fangst = self.fangst if eier is None else self.fangst[self.fangst["eier"] == eier]
        doegn = teiner["doegn"].sum()
        return {
            "settinger": len(teiner), "mistet": int(alle["mistet"].sum()),
            "med_hummer": int((teiner["hummer"] > 0).sum()), "teinedogn": doegn,
            "hummer": fangst["hummer"].sum(), "beholdt": fangst["beholdt"].sum(),
            "satt_ut": fangst["satt_ut"].sum(), "hummer_fra_teiner": teiner["hummer"].sum(),
            "per_teinedogn": teiner["hummer"].sum() / doegn,
        }

    def test_laget(self):
        self.sammenlign("laget", self.tall(), self.fasit["laget"])

    def test_per_person(self):
        for uid, forventet in self.fasit["per_person"].items():
            self.sammenlign(uid, self.tall(uid), forventet)

    def test_per_person_tabellen(self):
        """per_person() (tabellen i terminalen) gir de samme tallene."""
        personer = {"eposter": self.fasit["lag"]["eposter"], "initialer": self.fasit["lag"]["initialer"]}
        tabell = af.per_person(self.teiner, self.fangst, personer)
        for uid, forventet in self.fasit["per_person"].items():
            rad = tabell.loc[af.kortnavn(uid, personer)]
            self.sammenlign(uid, {
                "settinger": rad["settinger"], "med_hummer": rad["med_fangst"], "teinedogn": rad["teinedoegn"],
                "hummer": rad["hummer"], "beholdt": rad["beholdt"], "satt_ut": rad["satt_ut"],
                "per_teinedogn": rad["per_teinedoegn"],
            }, {k: v for k, v in forventet.items() if k not in ("mistet", "hummer_fra_teiner")})


if __name__ == "__main__":
    unittest.main()

"""Tegn app-ikonene (PNG) til app/ikoner/.

Motiv: skjærgård med dybdekurver og appens gule teinesymbol med blåse og flagg.
Tegnes i stor størrelse og skaleres ned, så kantene blir glatte.

  ikon-192.png, ikon-512.png  vanlige ikoner (avrundede hjørner)
  ikon-maskable-512.png       Android «adaptive icon»: helt utfylt, motivet innenfor trygg sone
  apple-touch-icon.png        iPhone/iPad (180 px, uten gjennomsiktighet)
  favicon-32.png              fane-ikon i nettleseren

Kjør fra roten av repoet:  python scripts/lag_ikoner.py
"""

import sys

from PIL import Image, ImageDraw

from config import ROOT

UT = ROOT / "app" / "ikoner"

HAV = (13, 59, 102)
KURVE = (127, 184, 224)
LAND = (244, 238, 219)
KYST = (122, 106, 76)
TEINE = (255, 176, 0)
MORK = (28, 19, 0)
HVIT = (255, 255, 255)

STOR = 2048  # tegnestørrelse før nedskalering


def tegn(avrundet: bool, motiv_andel: float) -> Image.Image:
    """Tegn ikonet. motiv_andel < 1 krymper motivet mot midten (for maskable)."""
    bilde = Image.new("RGBA", (STOR, STOR), HAV)
    d = ImageDraw.Draw(bilde)

    # Koordinater i motivet (0–1) -> piksler
    marg = (1 - motiv_andel) / 2

    def p(x, y):
        return (marg + x * motiv_andel) * STOR, (marg + y * motiv_andel) * STOR

    def boks(cx, cy, r):
        (x0, y0), (x1, y1) = p(cx - r, cy - r), p(cx + r, cy + r)
        return (x0, y0, x1, y1)

    def bredde(b):
        return max(1, int(b * motiv_andel * STOR))

    # Land nede til venstre, med dybdekurver rundt
    senter = (-0.08, 1.08)
    for r, b in ((0.98, 0.022), (0.82, 0.026), (0.68, 0.03)):
        d.arc(boks(*senter, r), 260, 370, fill=KURVE, width=bredde(b))
    d.ellipse(boks(*senter, 0.55), fill=LAND, outline=KYST, width=bredde(0.018))

    # Teinesymbolet: gul firkant med mørk kant og hvit ring
    cx, cy, s = 0.63, 0.40, 0.19
    for utvid, farge in ((0.03, HVIT), (0.0, MORK)):
        (x0, y0), (x1, y1) = p(cx - s - utvid, cy - s - utvid), p(cx + s + utvid, cy + s + utvid)
        d.rounded_rectangle((x0, y0, x1, y1), radius=int(0.07 * motiv_andel * STOR), fill=farge)
    (x0, y0), (x1, y1) = p(cx - s + 0.035, cy - s + 0.035), p(cx + s - 0.035, cy + s - 0.035)
    d.rounded_rectangle((x0, y0, x1, y1), radius=int(0.045 * motiv_andel * STOR), fill=TEINE)

    # Blåse med stang og flagg inni teinesymbolet
    d.line((p(cx - 0.01, cy + 0.02), p(cx - 0.01, cy - 0.12)), fill=MORK, width=bredde(0.022))
    d.polygon((p(cx - 0.01, cy - 0.125), p(cx + 0.09, cy - 0.09), p(cx - 0.01, cy - 0.055)), fill=MORK)
    d.ellipse(boks(cx - 0.01, cy + 0.06, 0.055), fill=MORK)

    if avrundet:  # klipp alt til avrundede hjørner til slutt
        maske = Image.new("L", bilde.size, 0)
        ImageDraw.Draw(maske).rounded_rectangle((0, 0, STOR - 1, STOR - 1), radius=int(STOR * 0.22), fill=255)
        bilde.putalpha(maske)
    return bilde


def lagre(bilde: Image.Image, navn: str, storrelse: int, gjennomsiktig: bool = True) -> None:
    liten = bilde.resize((storrelse, storrelse), Image.LANCZOS)
    if not gjennomsiktig:
        bakgrunn = Image.new("RGB", liten.size, HAV)
        bakgrunn.paste(liten, mask=liten.split()[3])
        liten = bakgrunn
    liten.save(UT / navn, optimize=True)
    print(f"  {navn} ({storrelse} px)")


def main() -> int:
    UT.mkdir(parents=True, exist_ok=True)
    vanlig = tegn(avrundet=True, motiv_andel=1.0)
    maskable = tegn(avrundet=False, motiv_andel=0.74)  # Android kan klippe bort kantene
    full = tegn(avrundet=False, motiv_andel=1.0)       # iPhone runder hjørnene selv
    print("Lager ikoner i app/ikoner/:")
    lagre(vanlig, "ikon-192.png", 192)
    lagre(vanlig, "ikon-512.png", 512)
    lagre(maskable, "ikon-maskable-512.png", 512, gjennomsiktig=False)
    lagre(full, "apple-touch-icon.png", 180, gjennomsiktig=False)
    lagre(vanlig, "favicon-32.png", 32)
    return 0


if __name__ == "__main__":
    sys.exit(main())

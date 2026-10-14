"""Tegn app-ikonene (PNG) til app/ikoner/.

Motiv: svart hummer (slik den er levende, før den kokes) sett ovenfra på mørkt
hav med dybdekurver. Hummeren har blågrå glans og en lys kant rundt, så den synes
mot havet. Tegnes i stor størrelse og skaleres ned, så kantene blir glatte.

  ikon-192.png, ikon-512.png  vanlige ikoner (avrundede hjørner)
  ikon-maskable-512.png       Android «adaptive icon»: helt utfylt, motivet innenfor trygg sone
  apple-touch-icon.png        iPhone/iPad (180 px, uten gjennomsiktighet)
  favicon-32.png              fane-ikon i nettleseren

Kjør fra roten av repoet:  python scripts/lag_ikoner.py
"""

import math
import sys

from PIL import Image, ImageDraw, ImageFilter

from config import ROOT

UT = ROOT / "app" / "ikoner"

HAV_GRUNT = (24, 92, 146)   # midt i ikonet
HAV_DYPT = (7, 32, 60)      # ut mot kantene
KURVE = (127, 184, 224, 95)
HUMMER = (16, 19, 24)          # nesten svart
HUMMER_GLANS = (62, 84, 110)   # blågrå glans på ryggen, som på levende hummer
HUMMER_LEDD = (78, 104, 134)   # leddene i halen og vifta
OYE = (170, 190, 210)
KANT = (214, 234, 247)         # lys kant rundt hummeren

STOR = 2048  # tegnestørrelse før nedskalering


def hav() -> Image.Image:
    """Bakgrunn: lysere (grunnere) i midten, mørkere ut mot kantene, med dybdekurver."""
    gradient = Image.radial_gradient("L").resize((STOR, STOR), Image.BICUBIC)
    bilde = Image.composite(Image.new("RGBA", (STOR, STOR), HAV_DYPT),
                            Image.new("RGBA", (STOR, STOR), HAV_GRUNT), gradient)

    # Bølgete, lukkede kurver rundt midten, som dybdekurver i et sjøkart
    kurver = Image.new("RGBA", (STOR, STOR), (0, 0, 0, 0))
    d = ImageDraw.Draw(kurver)
    for i, r in enumerate((0.30, 0.40, 0.50, 0.61, 0.73)):
        punkter = []
        for k in range(361):
            v = math.radians(k)
            bolge = 1 + 0.07 * math.sin(3 * v + i * 0.9) + 0.04 * math.sin(5 * v + 1.7 + i * 1.3)
            punkter.append(((0.5 + r * bolge * math.cos(v)) * STOR, (0.52 + r * bolge * math.sin(v)) * STOR))
        d.line(punkter, fill=KURVE, width=int(0.011 * STOR), joint="curve")
    return Image.alpha_composite(bilde, kurver)


def hummer(motiv_andel: float) -> Image.Image:
    """Hummeren på gjennomsiktig bakgrunn. motiv_andel < 1 krymper den mot midten."""
    lag = Image.new("RGBA", (STOR, STOR), (0, 0, 0, 0))
    d = ImageDraw.Draw(lag)
    marg = (1 - motiv_andel) / 2
    ned = 0.03  # klørne er tyngre enn halen, så motivet flyttes litt ned for balansens skyld

    # Koordinater i motivet (0–1, y nedover) -> piksler
    def p(x, y):
        return (marg + x * motiv_andel) * STOR, (marg + (y + ned) * motiv_andel) * STOR

    def b(bredde):
        return max(1, int(bredde * motiv_andel * STOR))

    def ellipse(cx, cy, rx, ry, vinkel=0.0, n=90):
        """Punkter rundt en ellipse som er rotert vinkel grader (positiv = med klokka)."""
        v = math.radians(vinkel)
        ut = []
        for k in range(n):
            t = 2 * math.pi * k / n
            x, y = rx * math.cos(t), ry * math.sin(t)
            ut.append(p(cx + x * math.cos(v) - y * math.sin(v), cy + x * math.sin(v) + y * math.cos(v)))
        return ut

    def bue(a, kontroll, c, n=40):
        """Kvadratisk Bézier-kurve fra a til c."""
        return [p((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * kontroll[0] + t * t * c[0],
                  (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * kontroll[1] + t * t * c[1])
                for t in (k / n for k in range(n + 1))]

    def strek(punkter, bredde, farge=HUMMER):
        d.line(punkter, fill=farge, width=b(bredde), joint="curve")
        r = b(bredde) / 2
        for x, y in (punkter[0], punkter[-1]):
            d.ellipse((x - r, y - r, x + r, y + r), fill=farge)

    for side in (-1, 1):
        # Antenner: lange buer ut til sidene og bakover langs kroppen
        strek(bue((0.5 + side * 0.03, 0.30), (0.5 + side * 0.40, 0.16), (0.5 + side * 0.41, 0.74)), 0.011)
        strek(bue((0.5 + side * 0.02, 0.30), (0.5 + side * 0.06, 0.16), (0.5 + side * 0.12, 0.13)), 0.009)

        # Fire par gangbein, skrått bakover
        for i in range(4):
            y = 0.41 + i * 0.04
            kne = (0.5 + side * (0.15 + i * 0.006), y + 0.015)
            fot = (0.5 + side * (0.18 - i * 0.004), y + 0.075)
            strek([p(0.5 + side * 0.06, y), p(*kne), p(*fot)], 0.014)

        # Klo-arm: fra skulderen ut og opp til håndleddet
        skulder, albue, handledd = (0.5 + side * 0.06, 0.37), (0.5 + side * 0.17, 0.33), (0.5 + side * 0.2, 0.25)
        strek([p(*skulder), p(*albue), p(*handledd)], 0.046)

        # Klo: bred håndflate og to fingre som bøyer seg mot hverandre, med åpning imellom.
        # Klo-koordinater: u på tvers, w langs kloa mot tuppen, origo midt i håndflaten.
        kx, ky, v = 0.5 + side * 0.215, 0.2, math.radians(side * 14)

        def i_klo(u, w):
            return (kx + u * math.cos(v) + w * math.sin(v), ky + u * math.sin(v) - w * math.cos(v))

        def klopunkter(a, kontroll, c):
            return bue(i_klo(*a), i_klo(*kontroll), i_klo(*c), n=30)

        d.polygon(ellipse(kx, ky, 0.074, 0.085, math.degrees(v)), fill=HUMMER)
        for f in (-1, 1):  # de to fingrene
            ytterkant = klopunkter((f * 0.072, 0.0), (f * 0.085, 0.15), (f * 0.014, 0.215))
            innerkant = klopunkter((f * 0.014, 0.215), (f * 0.034, 0.12), (f * 0.007, 0.06))
            d.polygon(ytterkant + innerkant, fill=HUMMER)
        d.polygon(ellipse(*i_klo(side * -0.02, -0.005), 0.024, 0.045, math.degrees(v)), fill=HUMMER_GLANS)

    # Halevifta: fem fliker som sprer seg ut fra enden av halen (tegnes først, under halen)
    feste = (0.5, 0.815)
    for vinkel in (-50, 50, -25, 25, 0):
        a = math.radians(vinkel)
        cx, cy = feste[0] + math.sin(a) * 0.052, feste[1] + math.cos(a) * 0.052
        d.polygon(ellipse(cx, cy, 0.03, 0.058, -vinkel), fill=HUMMER, outline=HUMMER_LEDD, width=b(0.006))

    # Ryggskjold med pigg (rostrum) foran
    d.polygon([p(0.5, 0.255), p(0.476, 0.33), p(0.524, 0.33)], fill=HUMMER)
    d.polygon(ellipse(0.5, 0.435, 0.092, 0.13), fill=HUMMER)
    d.polygon(ellipse(0.5, 0.45, 0.03, 0.09), fill=HUMMER_GLANS)
    for side in (-1, 1):
        x, y = p(0.5 + side * 0.034, 0.318)
        r = b(0.014)
        d.ellipse((x - r, y - r, x + r, y + r), fill=OYE)

    # Halen: seks ledd som smalner av, tegnet ovenfra og ned så hvert ledd overlapper det forrige
    for i, bredde in enumerate((0.160, 0.154, 0.144, 0.132, 0.118, 0.104)):
        topp = 0.545 + i * 0.044
        (x0, y0), (x1, y1) = p(0.5 - bredde / 2, topp), p(0.5 + bredde / 2, topp + 0.054)
        d.rounded_rectangle((x0, y0, x1, y1), radius=b(0.022), fill=HUMMER,
                            outline=HUMMER_LEDD, width=b(0.008))
        (x0, y0), (x1, y1) = p(0.5 - 0.022, topp + 0.012), p(0.5 + 0.022, topp + 0.042)
        d.rounded_rectangle((x0, y0, x1, y1), radius=b(0.012), fill=HUMMER_GLANS)
    return lag


def med_kant(lag: Image.Image, bredde: float = 0.011) -> Image.Image:
    """Legg en lys kant rundt motivet, så den svarte hummeren synes mot det mørke havet."""
    # Uskarp kopi av omrisset, gjort skarp igjen med en lav terskel: et litt større omriss
    alfa = lag.getchannel("A").filter(ImageFilter.GaussianBlur(bredde * STOR / 1.9))
    alfa = alfa.point(lambda v: 255 if v > 8 else 0).filter(ImageFilter.GaussianBlur(2))
    kant = Image.new("RGBA", lag.size, KANT)
    kant.putalpha(alfa)
    return Image.alpha_composite(kant, lag)


def tegn(avrundet: bool, motiv_andel: float) -> Image.Image:
    bilde = Image.alpha_composite(hav(), med_kant(hummer(motiv_andel)))
    if avrundet:  # klipp alt til avrundede hjørner til slutt
        maske = Image.new("L", bilde.size, 0)
        ImageDraw.Draw(maske).rounded_rectangle((0, 0, STOR - 1, STOR - 1), radius=int(STOR * 0.22), fill=255)
        bilde.putalpha(maske)
    return bilde


def lagre(bilde: Image.Image, navn: str, storrelse: int, gjennomsiktig: bool = True) -> None:
    liten = bilde.resize((storrelse, storrelse), Image.LANCZOS)
    if not gjennomsiktig:
        bakgrunn = Image.new("RGB", liten.size, HAV_DYPT)
        bakgrunn.paste(liten, mask=liten.split()[3])
        liten = bakgrunn
    liten.save(UT / navn, optimize=True)
    print(f"  {navn} ({storrelse} px)")


def main() -> int:
    UT.mkdir(parents=True, exist_ok=True)
    vanlig = tegn(avrundet=True, motiv_andel=0.9)
    maskable = tegn(avrundet=False, motiv_andel=0.72)  # Android kan klippe bort kantene
    full = tegn(avrundet=False, motiv_andel=0.9)       # iPhone runder hjørnene selv
    print("Lager ikoner i app/ikoner/:")
    lagre(vanlig, "ikon-192.png", 192)
    lagre(vanlig, "ikon-512.png", 512)
    lagre(maskable, "ikon-maskable-512.png", 512, gjennomsiktig=False)
    lagre(full, "apple-touch-icon.png", 180, gjennomsiktig=False)
    lagre(tegn(avrundet=True, motiv_andel=1.0), "favicon-32.png", 32)
    return 0


if __name__ == "__main__":
    sys.exit(main())

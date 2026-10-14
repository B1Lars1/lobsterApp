# Hummerkart Lillesand

En enkel web-app (PWA) for hummerfiske i skjærgården ved Lillesand. Appen legges
til på hjemskjermen på telefonen og viser:

- sjøkart med dybdekurver
- egen posisjon fra GPS
- teiner og fangst som du markerer med ett trykk
- hummerfredningsområder i Agder

Markeringene lagres bare lokalt på telefonen. De kan eksporteres som GeoJSON og
analyseres i GeoPandas.

> **Ikke for navigasjon.** Dybdedataene i appen er ikke godkjent for navigasjon.
> Bruk offisielle sjøkart.

## Status

| Fase | Innhold | Status |
|---|---|---|
| 1 | Oppsett: repo, mappestruktur, Python-miljø | ✅ |
| 2 | Dybdedata: nedlasting og behandling | ✅ |
| 3 | Kart og GPS | |
| 4 | Markeringer, lagring, eksport/import | |
| 5 | Fredningsområder og dybdeoppslag | |
| 6 | PWA og offline | |
| 7 | Publisering på GitHub Pages | |
| 8 | Analyse av fangst | |

## Mappestruktur

```
app/              Web-appen (statiske filer, publiseres på GitHub Pages)
  data/           Ferdige, små GeoJSON-filer som appen leser (i git)
data/
  raw/            Nedlastede rådata (ikke i git)
  processed/      Mellomprodukter i full oppløsning (ikke i git)
  private/        Dine egne markeringer (ALDRI i git)
scripts/          Python-skript for databehandling
```

`data/raw`, `data/processed` og `data/private` står i `.gitignore` og finnes
derfor ikke på GitHub. Skriptet `scripts/sjekk_miljo.py` oppretter dem.

## Personvern

Repoet er offentlig. Egne teineplasser og fangst skal aldri inn i det:

- Lagre eksporterte markeringer i `data/private/`. Hele mappen ignoreres av git.
- Filer som heter `markeringer*.geojson` ignoreres uansett hvor i repoet de ligger.
- Testdata i repoet skal bare inneholde oppdiktede punkter.

## Python-miljø (Windows/PowerShell)

Krever Python 3.14 (`py -3.14`). Fra roten av repoet:

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe scripts\sjekk_miljo.py
```

Du kan også aktivere miljøet med `.\.venv\Scripts\Activate.ps1` og deretter
bruke `python` og `pip` direkte.

## Dybdedata

```powershell
.\.venv\Scripts\python.exe scripts\last_ned_dybdedata.py   # ca. 30 MB til data/raw/
.\.venv\Scripts\python.exe scripts\lag_dybdekart.py        # skriver til app/data/
```

`last_ned_dybdedata.py` bestiller Kartverkets «Sjøkart – Dybdedata» (File
Geodatabase, UTM32) for Lillesand og Grimstad via Geonorges nedlastings-API.
Bruk `--force` for å hente nyeste versjon (Kartverket oppdaterer ukentlig).

`lag_dybdekart.py` klipper til kartutsnittet (lon 8,28–8,52, lat 58,17–58,29),
forenkler, reprojiserer til EPSG:4326 og skriver:

| Fil i `app/data/` | Innhold | Egenskaper |
|---|---|---|
| `dybdekurver.geojson` | Dybdekurver 2, 3, 5, 10, 15, 20, 30, 40, 50, 100 og 150 m | `dybde` |
| `dybdeareal.geojson` | Dybdeområder mellom kurvene | `min`, `maks` |
| `land.geojson` | Land og tørrfall, grunnkart når appen er offline | `kategori` |
| `dybdetall.geojson` | Dybdepunkter, grunner og skjær | `kategori`, `dybde` |
| `kilder.json` | Kilde, lisens og nedlastingsdato | |

Filene er til sammen ca. 7 MB, eller ca. 1 MB komprimert slik de sendes over
nettet. Dybdeareal, land og tørrfall forenkles samlet («coverage simplification»),
så naboflatene fortsatt passer sammen uten sprekker.

Samme data i full oppløsning (UTM32) lagres i
`data/processed/dybdedata_lillesand.gpkg` for analyse:

```python
import geopandas as gpd
punkter = gpd.read_file("data/processed/dybdedata_lillesand.gpkg", layer="dybdepunkt")
```

**Hvorfor ikke tettere dybdekurver?** Kartverkets terrengmodeller med 5 og
25 m oppløsning dekker ikke Lillesand. Dybdedata tettere enn 50 m innenfor
territorialgrensen er gradert, og terrengmodellene finnes i hovedsak bare
utenfor grensen. 50 m-modellen dekker bare enkelte felt i utsnittet. De åpne
vektordataene (dybdepunkter med ca. 50 m avstand og kurvene over) er derfor
det beste grunnlaget som finnes.

## Teste appen lokalt

```powershell
.\.venv\Scripts\python.exe -m http.server 8000 --directory app
```

Åpne <http://localhost:8000> i nettleseren. GPS-posisjon fungerer på
`localhost`, men på telefonen krever nettleseren HTTPS. Telefonen testes derfor
mot versjonen på GitHub Pages.

## Publisering

Appen publiseres fra mappen `app/` til GitHub Pages med en GitHub Actions-workflow
ved hver push til `main`. Oppsettet beskrives i fase 7.

## Kilder og kreditering

- **Dybdedata:** «Sjøkart – Dybdedata», © Kartverket, lisens
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  [Metadata i Geonorge](https://kartkatalog.geonorge.no/metadata/2751aacf-5472-4850-a208-3532a51c529a).
  Dataene er forenklet og klippet. De er ikke godkjent for navigasjon, og
  dybdene er referert til sjøkartnull.
- **Bakgrunnskart:** © Kartverket. Tjeneste og vilkår skrives inn i fase 3.
- **Hummerfredningsområder:** Fiskeridirektoratet. Kilden bekreftes i fase 5.
- **Kartbibliotek:** [Leaflet](https://leafletjs.com/) (BSD 2-Clause).

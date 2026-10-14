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
| 3 | Kart og GPS | ✅ |
| 4 | Markeringer, lagring, eksport/import | ✅ |
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
| `kurveetiketter.geojson` | Plassering og vinkel for tall langs kurvene | `dybde`, `vinkel`, `niva` |
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
.\.venv\Scripts\python.exe scripts	estserver.py
```

Testserveren ber nettleseren om ikke å mellomlagre filene, så endringer i koden
vises med en gang du laster siden på nytt.

Åpne <http://localhost:8000> i nettleseren. GPS-posisjon fungerer på
`localhost`, men på telefonen krever nettleseren HTTPS. Telefonen testes derfor
mot versjonen på GitHub Pages.

PC-en har som regel ikke GPS. Bruk en simulert posisjon for å teste:
<http://localhost:8000/?simuler=58.2405,8.3810>

Bruk gjerne nettleserens mobilvisning (F12 → enhetsverktøylinjen) for å se
appen i telefonformat.

## Appen

Appen er ren HTML, CSS og JavaScript uten byggesteg. Leaflet ligger i
`app/vendor/`, så appen ikke er avhengig av en ekstern CDN.

| Fil | Hva den gjør |
|---|---|
| `index.html` | Skjermoppsett: kart, GPS-status, knapper og innstillingsark |
| `css/app.css` | Utseende, lys og mørk modus (fargevariabler øverst) |
| `js/app.js` | Hovedfil: kart, kartlag, knapper, tema og innstillinger |
| `js/dybdelag.js` | Tegner dybdekartet som kartfliser, med farger og tekst |
| `js/gps.js` | GPS-posisjon, nøyaktighetssirkel, fartsretning og «følg meg» |
| `js/innstillinger.js` | Husker tema og kartvalg i nettleseren |
| `js/markeringer.js` | Teiner og fangst: data, lagring og GeoJSON-eksport/-import |
| `js/lager.js` | Lagring i nettleserens database (IndexedDB) |
| `js/kartmarkeringer.js` | Symbolene for teiner og fangst på kartet |
| `js/markeringsark.js` | Knappene og arkene for å sette, endre, flytte og slette |
| `js/melding.js` | Korte meldinger med «Angre» |

**Kartvalg** (knappen øverst til høyre):

- **Dybdekart:** bare våre egne data. Fungerer uten nett.
- **Topo + dybde:** Kartverkets gråtone-topokart med dybdesoner og kurver oppå.
- **Sjøkart:** Kartverkets sjøkart.

**Ytelse:** dybdekartet tegnes som kartfliser på `<canvas>`. Hver flis tegnes
én gang og gjenbrukes når du panorerer. Et rutenett (romlig indeks) gjør at hver
flis bare ser på objektene i nærheten. Når kartet er zoomet ut, hoppes det over
punkter som ligger nærmere hverandre enn én piksel, og bare hovedkurvene (5, 10,
20 og 50 m) tegnes. Tall langs kurvene og dybdetall dukker opp gradvis når du
zoomer inn.

**Batteri:** GPS-en er bare på mens appen er synlig. Den stoppes når skjermen
slås av eller du bytter app.

## Markeringer

- **Sett teine:** ett trykk markerer en teine der du er (GPS). Den får laveste
  ledige nummer, som kan endres.
- **Hummer her:** ett trykk registrerer fangst der du er. Fangsten knyttes til
  nærmeste teine innenfor 50 m. Juster antall beholdt og satt ut med + og −.
- **Langt trykk i kartet** (høyreklikk på PC): marker et valgfritt sted.
- **Trykk på en teine eller fangst:** se detaljer, endre nummer og notat,
  registrere fangst, flytte eller slette.
- **Listeknappen** øverst viser teinene i sjøen med avstand og retning fra båten.
  Tallet på knappen er antall teiner i sjøen.
- **Tatt opp** fjerner teinen fra kartet, men tar vare på den i historikken for
  analyse. **Slett** fjerner markeringen helt (for feil). Begge kan angres.

Markeringene lagres i nettleserens database (IndexedDB) på telefonen og ligger
der når appen åpnes igjen, også uten nett. De forsvinner hvis nettleserdataene
for siden slettes. På iPhone kan Safari dessuten slette data for nettsider som
ikke er brukt på 7 dager, men det gjelder ikke apper lagt til på hjemskjermen.
Eksporter derfor jevnlig. Tidspunktet for siste eksport står i innstillingsarket.

### Eksport til GeoPandas

Innstillingsarket → **Eksporter GeoJSON** gir filen `markeringer-ÅÅÅÅ-MM-DD.geojson`.
På telefonen åpnes delingsmenyen (lagre i Filer, send på e-post), og på PC lastes
filen ned. Legg filen i `data/private/`, som aldri kommer med i git:

```python
import geopandas as gpd
m = gpd.read_file("data/private/markeringer-2026-10-14.geojson")
fangst = m[m["kategori"] == "hummer"]
```

| Felt | Innhold |
|---|---|
| `id` | Unik id |
| `kategori` | `teine` eller `hummer` |
| `tid`, `endret` | Satt/registrert og sist endret (ISO 8601, UTC) |
| `notat` | Fritekst |
| `dybde` | Dybde fra dybdedataene (fra fase 5) |
| `noyaktighet` | GPS-nøyaktighet i meter, tom hvis plassert i kartet |
| `kilde` | `gps` eller `kart` |
| `nummer`, `status`, `tatt_opp` | Teinenummer, `i_sjoen`/`tatt_opp`, tidspunkt tatt opp (teiner) |
| `beholdt`, `satt_ut`, `teine_id` | Antall hummer og hvilken teine fangsten kom fra (fangst) |

**Importer** leser en slik fil tilbake. Markeringer med samme id oppdateres bare
hvis filen har en nyere versjon, så det er trygt å importere samme fil flere ganger.

## Publisering

Appen publiseres fra mappen `app/` til GitHub Pages med en GitHub Actions-workflow
ved hver push til `main`. Oppsettet beskrives i fase 7.

## Kilder og kreditering

- **Dybdedata:** «Sjøkart – Dybdedata», © Kartverket, lisens
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  [Metadata i Geonorge](https://kartkatalog.geonorge.no/metadata/2751aacf-5472-4850-a208-3532a51c529a).
  Dataene er forenklet og klippet. De er ikke godkjent for navigasjon, og
  dybdene er referert til sjøkartnull.
- **Bakgrunnskart:** © Kartverket, lisens CC BY 4.0. WMTS-tjenesten
  `cache.kartverket.no` (lagene `topograatone` og `sjokartraster`, fra
  [GetCapabilities](https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml)).
  Flisene vises direkte fra tjenesten og lagres ikke av appen for bruk uten nett.
  Ifølge [Kartverkets vilkår](https://www.kartverket.no/api-og-data/vilkar-for-bruk)
  inneholder kartene Geovekst-data på zoomnivå 12–20, og kopiering krever særskilt
  tillatelse. Uten nett brukes derfor bare dybdedataene over.
- **Hummerfredningsområder:** Fiskeridirektoratet. Kilden bekreftes i fase 5.
- **Kartbibliotek:** [Leaflet](https://leafletjs.com/) (BSD 2-Clause).

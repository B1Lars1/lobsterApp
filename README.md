# Hummerkart Lillesand

En enkel web-app (PWA) for hummerfiske i skjærgården ved Lillesand. Appen legges
til på hjemskjermen på telefonen og viser:

- dybdekart med dybdekurver, stedsnavn og hint om bunnforhold
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
| 5 | Fredningsområder og dybdeoppslag | ✅ |
| 6 | PWA og offline | ✅ |
| 7 | Publisering på GitHub Pages | ✅ |
| 8 | Analyse av fangst | ✅ |
| 9 | Finpuss: gjenoppretting av slettede markeringer, nye teinesymboler og app-ikon, dobbelttrykk for zoom, rettet plassering av symbolene | ✅ |

## Mappestruktur

```
app/              Web-appen (statiske filer, publiseres på GitHub Pages)
  data/           Ferdige, små GeoJSON-filer som appen leser (i git)
data/
  raw/            Nedlastede rådata (ikke i git)
  processed/      Mellomprodukter i full oppløsning (ikke i git)
  private/        Dine egne markeringer (ALDRI i git)
scripts/          Python-skript for databehandling
CLAUDE.md         Instruksjoner for kodeagenter (Claude Code) som jobber i repoet
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

### macOS og Linux

Kommandoene i denne README-en er skrevet for PowerShell. På Mac og Linux er stien
til Python i miljøet `.venv/bin/python`, med skråstrek fremover:

```bash
python3.14 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python scripts/sjekk_miljo.py
```

Testserveren, `lag_service_worker.py` og `lag_ikoner.py` virker også med eldre
Python 3. `lag_ikoner.py` trenger bare Pillow (`.venv/bin/python -m pip install pillow`).
For å pushe fra en ny maskin må git være logget inn på GitHub, for eksempel med
GitHub CLI: `gh auth login` og deretter `gh auth setup-git`.

## Dybdedata

```powershell
.\.venv\Scripts\python.exe scripts\last_ned_dybdedata.py   # ca. 55 MB til data/raw/
.\.venv\Scripts\python.exe scripts\lag_dybdekart.py        # ca. 5 min, skriver til app/data/
```

`last_ned_dybdedata.py` bestiller Kartverkets «Sjøkart – Dybdedata» (File
Geodatabase, UTM32) for Kristiansand, Lillesand og Grimstad via Geonorges
nedlastings-API.
Bruk `--force` for å hente nyeste versjon (Kartverket oppdaterer ukentlig).

`lag_dybdekart.py` klipper til kartområdet, forenkler, reprojiserer til
EPSG:4326 og skriver filene under. Kartområdet er alt land innenfor utsnittet
(lon 8,08–8,70, lat 58,08–58,37, fra østre del av Kristiansand til Grimstad) og
sjø inntil 3 km fra nærmeste land, holme eller skjær. Begge deler styres av
`BBOX_WGS84` og `SJO_AVSTAND_M` i `scripts/config.py`. Endrer du utsnittet, må
også `DATAOMRADE` i `app/js/app.js` endres.

| Fil i `app/data/` | Innhold | Egenskaper |
|---|---|---|
| `dybdekurver.geojson` | Dybdekurver 2, 3, 5, 10, 15, 20, 30, 40, 50, 100 og 150 m | `dybde` |
| `dybdeareal.geojson` | Dybdeområder mellom kurvene | `min`, `maks` |
| `land.geojson` | Land og tørrfall, grunnkart når appen er offline | `kategori` |
| `dybdetall.geojson` | Dybdepunkter, grunner og skjær | `kategori`, `dybde` |
| `kurveetiketter.geojson` | Plassering og vinkel for tall langs kurvene | `dybde`, `vinkel`, `niva` |
| `stedsnavn.geojson` | Navn på øyer, holmer, grunner, båer og skjær (se under) | `navn`, `stil`, `zoom` |
| `bunnhint.geojson` | Tareskog, ålegras og skjellsand som hint om bunnen (se under) | `kategori`, `navn`, `modellert`, `aar` |
| `kilder.json` | Kilde, lisens og nedlastingsdato | |

Filene er til sammen ca. 21 MB, eller ca. 2,7 MB komprimert slik de sendes over
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
.\.venv\Scripts\python.exe scripts\testserver.py
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
| `js/dra-ned.js` | Lukker arkene når du drar dem ned |
| `js/dobbelttrykk.js` | Dobbelttrykk med fingeren zoomer inn (iPhone) |
| `js/hjemskjerm.js` | Veiledning for å legge appen til på hjemskjermen (iPhone og Android) |
| `js/synk.js` | Synkronisering med et privat GitHub-repo |
| `js/dybdeoppslag.js` | Anslår dybden i et punkt (markeringer og der du er) |
| `js/fredning.js` | Fredningsområder for hummer: kartlag og sjekk av punkter |

**Arkene** som kommer opp nedenfra (innstillinger, teineliste, detaljer) lukkes med
«Ferdig», ved å trykke utenfor, eller ved å dra dem ned i håndtaket øverst.

**Kartet:** dra for å flytte, knip eller bruk + og − for å zoome. Dobbelttrykk
(dobbeltklikk på PC) zoomer inn ett nivå der du trykker. På iPhone tas dobbelttrykket
hånd om av `js/dobbelttrykk.js`, siden Safari ikke sender det videre til Leaflet. Langt
trykk markerer et sted (se «Markeringer»). Tekst på kartet og knappene kan ikke merkes,
så et langt trykk ikke merker for eksempel målestokken på iPhone.

**Kartvalg** (knappen øverst til høyre):

- **Dybdekart:** bare våre egne data. Fungerer uten nett.
- **Topo + dybde:** Kartverkets gråtone-topokart med dybdesoner og kurver oppå.

**Ytelse:** dybdekartet tegnes som kartfliser på `<canvas>`. Hver flis tegnes
én gang og gjenbrukes når du panorerer. Et rutenett (romlig indeks) gjør at hver
flis bare ser på objektene i nærheten. Når kartet er zoomet ut, hoppes det over
punkter som ligger nærmere hverandre enn én piksel, og bare hovedkurvene (5, 10,
20 og 50 m) tegnes. Tall langs kurvene og dybdetall dukker opp gradvis når du
zoomer inn.

**Batteri:** GPS-en er bare på mens appen er synlig. Den stoppes når skjermen
slås av eller du bytter app.

## Stedsnavn

```powershell
.\.venv\Scripts\python.exe scripts\lag_stedsnavn.py
```

Henter Kartverkets stedsnavn for Kristiansand, Lillesand og Grimstad fra det åpne
stedsnavn-API-et og beholder øyer, holmer, grunner, båer, klakker og skjær i sjø
innenfor kartområdet. Krever at `lag_dybdekart.py` er kjørt først.

For at kartet ikke skal bli støyete, får hvert navn et laveste zoomnivå:

- Store øyer vises først (zoom 11–13), deretter mindre øyer, holmer og grunner
  (zoom 14–15), og små holmer, båer og skjær når du er helt inne (zoom 15–16).
- Navnene plasseres i viktighetsrekkefølge. Et navn som ville kommet for nær et
  annet, venter til et høyere zoomnivå der det er plass.
- Tall langs kurvene og dybdetall som ville overlappet et navn, utelates.

Øynavn står i mørk, rett skrift. Grunner og båer står i blå kursiv litt under
punktet, som i sjøkartet. Navnene vises bare på «Dybdekart», siden Kartverkets
kart har egne navn. Avstand og zoomnivåer kan justeres øverst i skriptet
(`TYPER`, `LUFT_X`, `LUFT_Y`).

## Bunnforhold

Det finnes ikke noe åpent kart over bunntype (fjell, stein, sand) for området:
NGUs detaljerte sedimentkart og Havforskningsinstituttets bunnobservasjoner dekker
ikke Lillesand, og NGUs oversiktskart (1:1 mill.) er for grovt. Appen viser derfor
hint fra marine naturtyper fra zoom 15:

```powershell
.\.venv\Scripts\python.exe scripts\lag_bunnhint.py      # Miljødirektoratets marine naturtyper
```

Marine naturtyper fra Miljødirektoratet (HB19): tareskog vokser på fjell og stein
(grønne prikker). Ålegras, skjellsand og bløtbunnsområder ligger på sand eller
mudder (gult med stiplet kant). Tareskog og skjellsand er for det meste modellert,
ålegras er kartlagt i felt.

Trykk i kartet for å se hva som er der (for eksempel «Tareskog (modellert):
trolig fjell og stein»). Der det ikke står noe, er bunnen ukjent. Laget kan slås
av i innstillingsarket.

## Fredningsområder og dybde

```powershell
.\.venv\Scripts\python.exe scripts\lag_fredningsomrader.py
```

Skriptet henter Fiskeridirektoratets fredningsområder for hummer (WFS-laget
`FiskeridirWFS_fiskeri:hummer_fredningsomraader`) og skriver områdene i Agder til
`app/data/fredningsomrader.geojson`. Kjør det på nytt før hver sesong, siden
forskriften endres.

I appen:

- Fredningsområdene vises rødt skravert. Trykk på et område for regler og lenke
  til forskriften.
- Er du inne i et fredningsområde, vises en rød brikke under GPS-statusen.
- Settes eller flyttes en teine inn i et fredningsområde, kommer en rød advarsel,
  og teinen får et rødt «!» på kartet og et varsel i arket.
- Under GPS-statusen vises anslått dybde der du er. Nye og flyttede markeringer
  får dybde automatisk. Anslaget finner dybdesonen og vekter dybdemålingene
  innenfor 150 m etter avstand. Med ca. 50 m mellom målingene må du regne med
  noen meters usikkerhet.

Grensene er fra Fiskeridirektoratets kartdata og kan henge etter forskriften.
Sjekk alltid gjeldende forskrift.

## Markeringer

- **Sett teine:** ett trykk markerer en teine der du er (GPS). Den får laveste
  ledige nummer, som kan endres.
- **Hummer her:** ett trykk åpner et ark for ny fangst der du er. Fangsten knyttes
  til nærmeste teine innenfor 50 m. Juster antall beholdt og satt ut med + og −, og
  trykk **Ferdig** for å registrere den. Trykker du **Avbryt**, drar arket ned eller
  trykker utenfor, registreres ingenting. Det samme gjelder **Registrer fangst** i
  teinearket og «Hummer her» etter langt trykk i kartet.
- **Langt trykk i kartet** (høyreklikk på PC): marker et valgfritt sted.
- **Trykk på en teine eller fangst:** se detaljer, endre nummer og notat,
  registrere fangst, flytte eller slette.
- **Listeknappen** øverst viser teinene i sjøen med avstand og retning fra båten.
  Tallet på knappen er antall teiner i sjøen.
- **Rette fangst:** fangst registrert fra en teine ligger på samme sted som teinen, og
  er derfor gjemt under teinesymbolet på kartet. Du finner den i teinearket (under
  faktaboksene) og under **Fangstregistreringer** nederst i listen, sist registrert
  først. Trykk på en fangst for å endre antall beholdt og satt ut, tidspunkt, teine
  eller notat, flytte den eller slette den.
- **Tatt opp** fjerner teinen fra kartet, men tar vare på den i historikken for
  analyse. **Slett** fjerner markeringen helt (for feil). Begge kan angres.
- **Slettede markeringer** nederst i listen viser alt du har slettet, sist slettet
  først. Trykk **Gjenopprett** for å få en markering tilbake, også lenge etter at
  «Angre» er borte. En teine du angrer rett etter at du satte den, havner ikke her.
  Kopiene av slettede markeringer ligger bare på telefonen der de ble slettet (eller
  som hadde markeringen da slettingen kom via synkronisering).

**Symbolene på kartet:**

- **Teine i sjøen:** svart bøyleteine sett fra siden, med nummeret midt på og hvit
  kant rundt. Tegningen er `app/ikoner/teine.svg`.
- **Teine tatt opp:** samme teine i grått og stiplet (`teine-opptatt.svg`). Vises bare
  når «Teiner som er tatt opp» er slått på i innstillingene.
- **Fangst:** hvit sirkel med hummer og rød kant, med antall hvis det er mer enn én.
- **Rødt «!»:** teinen står i et fredningsområde.
- **Blå prikk:** der du er, med en gjennomsiktig sirkel som viser GPS-nøyaktigheten.

Markeringene lagres i nettleserens database (IndexedDB) på telefonen og ligger
der når appen åpnes igjen, også uten nett. Med synkronisering (se under) får du i
tillegg en automatisk kopi i et privat GitHub-repo. De forsvinner hvis nettleserdataene
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

### Synkronisering med GitHub (sikkerhetskopi og deling)

Appen kan lagre alle markeringene automatisk i et **privat** GitHub-repo, som
filen `markeringer.geojson`. Synkroniseringen skjer når appen åpnes, kort tid
etter hver endring og når telefonen får nett igjen. Den henter først filen fra
GitHub, slår den sammen med markeringene på telefonen (nyeste versjon vinner, og
slettinger følger med) og lagrer resultatet tilbake. Hver lagring blir en commit,
så repoet har full historikk.

**Oppsett (én gang):**

1. **Lag et privat repo:** <https://github.com/new>. Kall det for eksempel
   `hummerkart-data`, velg **Private** og trykk **Create repository**. Det kan
   være helt tomt.
2. **Lag en tilgangsnøkkel som bare gjelder dette repoet:**
   <https://github.com/settings/personal-access-tokens/new>
   - **Token name:** `Hummerkart`
   - **Expiration:** for eksempel ett år (appen sier fra når den har utløpt)
   - **Repository access:** **Only select repositories** → `hummerkart-data`
   - **Permissions → Repository permissions → Contents:** **Read and write**
   - Trykk **Generate token** og kopier nøkkelen (vises bare én gang).
3. **I appen:** Innstillinger → **Synkronisering med GitHub**. Skriv
   `B1Lars1/hummerkart-data` som repo, lim inn nøkkelen og trykk
   **Synkroniser nå**. Statusen blir grønn når det virker.
4. **Flere telefoner:** gjør punkt 3 på hver telefon. De får de samme
   markeringene.

Nøkkelen lagres bare på telefonen. Mister du telefonen, sletter du nøkkelen på
<https://github.com/settings/personal-access-tokens>. «Koble fra» i appen
fjerner oppsettet, men rører ikke markeringene.

**Til analyse:** hent repoet inn i `data/private/` (som aldri kommer med i dette
offentlige repoet):

```powershell
git clone https://github.com/B1Lars1/hummerkart-data.git data/private/hummerkart-data
git -C data/private/hummerkart-data pull   # senere: hent siste versjon
```

```python
m = gpd.read_file("data/private/hummerkart-data/markeringer.geojson")
```

**Deling:** i det private repoet → **Settings → Collaborators → Add people**.
De får en invitasjon og må ha GitHub-konto. Merk:

- I et repo på en personlig konto får de som inviteres **både lese- og
  skrivetilgang**. Skal noen bare kunne se, må repoet ligge i en (gratis)
  GitHub-organisasjon der du kan gi rollen **Read**, eller så sender du dem en
  eksportert fil.
- Kobler de egen app til samme repo, blir det en **felles logg**: de ser dine
  teiner og fangst, og deres markeringer havner i samme fil.
- Tilgangen trekkes tilbake samme sted.

## Analyse av fangst

```powershell
git -C data/private/hummerkart-data pull                 # hent siste synkronisering
.\.venv\Scripts\python.exe scripts\analyser_fangst.py
```

Skriptet leser markeringene fra det klonede synk-repoet
(`data/private/hummerkart-data/markeringer.geojson`), eller fra nyeste eksport
(`data/private/markeringer-*.geojson`) hvis repoet ikke er klonet. Du kan også
oppgi en fil: `python scripts/analyser_fangst.py sti/til/fil.geojson`.

Fangst måles som **hummer per teinedøgn**: antall hummer (beholdt + satt ut) delt
på antall døgn teinene har stått i sjøen. Da teller også teiner uten fangst, og en
teine som har stått i tre døgn, veier mer enn en som ble tatt opp etter en time.
Teiner som fortsatt står i sjøen, regnes frem til nå. Fangst må være knyttet til en
teine for å telle med. Det skjer automatisk når du trykker «Hummer her» ved teinen
eller «Registrer fangst» i teinearket.

Resultatet skrives i terminalen og til `data/private/analyse/` (aldri i git):

| Fil | Innhold |
|---|---|
| `fangst.png` | Fangst etter dybde, hver teinesetting mot dybde, fangst etter bunnhint og fangst per dag (beholdt og satt ut) |
| `teinesettinger.csv` | Én rad per teinesetting: tid, døgn i sjøen, dybde, bunnhint, antall hummer og posisjon |

Dybden er anslått fra Kartverkets dybdedata (se «Fredningsområder og dybde»), og
bunnhint kommer fra Miljødirektoratet. Med få teinedøgn (under 30) sier skriptet
fra om at forskjellene er usikre. Se på antall døgn under hver stolpe før du trekker
konklusjoner.

## Bruk uten nett (PWA)

Appen er en PWA («progressiv web-app»): den kan legges til på hjemskjermen og
åpnes i fullskjerm som en vanlig app.

- `manifest.webmanifest` gir navn, ikon og fullskjerm.
- App-ikonene (PNG) i `app/ikoner/` lages av `scripts/lag_ikoner.py`: en svart hummer
  (slik den er levende, før den kokes) med blågrå glans og lys kant, på mørkt hav med
  dybdekurver. Teinesymbolene på kartet, `teine.svg` og `teine-opptatt.svg`, er tegnet
  for hånd i samme mappe.
- `sw.js` (service worker) lagrer appen og alle kartdataene på telefonen første
  gang den åpnes med nett, ca. 22 MB. Deretter virker appen helt uten nett:
  dybdekart, stedsnavn, fredningsområder, dybdeoppslag og markeringer.
- Kartverkets topokart lagres ikke (se «Kilder og kreditering»). Uten
  nett bytter appen automatisk til dybdekartet.

**Etter endringer i appen eller dataene** må fillisten og versjonen i `sw.js`
oppdateres:

```powershell
.\.venv\Scripts\python.exe scripts\lag_service_worker.py
```

Versjonen er en sjekksum av alle filene. Telefonen ser at versjonen er ny neste
gang appen åpnes med nett, laster ned den nye versjonen i bakgrunnen og viser
«Ny versjon av appen er klar». GitHub Actions-workflowen (fase 7) kjører skriptet
automatisk ved publisering, så du ikke kan glemme det.

På `localhost` henter service workeren filene fra testserveren først, så
endringer vises med en gang du utvikler. Lagret versjon brukes bare når serveren
ikke svarer. Slik kan du også teste bruk uten nett: stopp testserveren og last
siden på nytt.

## Publisering

Appen ligger på **<https://b1lars1.github.io/lobsterApp/>**.

Workflowen `.github/workflows/publiser.yml` publiserer mappen `app/` til GitHub
Pages ved hver push til `main` som endrer appen. Den kjører først
`scripts/lag_service_worker.py`, så telefonene får den nye versjonen. Du kan følge
publiseringen under fanen **Actions** i repoet. Den tar et par minutter.
Publisering kan også startes for hånd: **Actions → Publiser appen → Run workflow**.

### Engangsoppsett i GitHub

1. Åpne repoet på GitHub og gå til **Settings** (tannhjulet øverst).
2. Velg **Pages** i menyen til venstre.
3. Under **Build and deployment → Source**, velg **GitHub Actions**.
4. Gå til **Actions**, velg **Publiser appen** og trykk **Run workflow** (eller
   push en endring i `app/`).
5. Når kjøringen er grønn, vises adressen under **Settings → Pages**.

### Legg appen til på hjemskjermen

Første gang må telefonen ha nett. Vent til meldingen «Appen er lagret og virker
nå uten nett» kommer (lagrer ca. 22 MB).

**Appen viser selv hvordan:** åpnes lenken i nettleseren på en telefon, kommer det
opp et ark med fremgangsmåten for telefonen som brukes. På Android (Chrome) er det
oftest en knapp, **Installer appen**, som installerer den direkte. På iPhone viser
arket veien via Del-knappen i Safari, og minner om at markeringer gjort i nettleseren
ikke blir med over til appen. Arket kommer hver gang lenken åpnes i nettleseren på
telefonen, siden appen er ment å brukes fra hjemskjermen. **Ikke nå** lukker det for
denne gangen. Det kan også åpnes fra innstillingsarket med
**Legg appen til på hjemskjermen**. Fra hjemskjermen og på PC vises ingen av delene.
Fremgangsmåten for hånd står under.

**iPhone (Safari):**

1. Åpne <https://b1lars1.github.io/lobsterApp/> i **Safari**.
2. Trykk på knappen med tre streker til venstre for adressefeltet, og velg **Del**
   (firkant med pil opp). På eldre iPhoner ligger **Del** rett i verktøylinjen.
3. Velg **Legg til på Hjem-skjerm**, la **Åpne som nettapp** være på hvis du ser det
   valget, og trykk **Legg til**.
4. Åpne appen fra ikonet. Tillat posisjon når du blir spurt.
5. Hvis GPS ikke virker: **Innstillinger → Personvern og sikkerhet →
   Stedstjenester → Safari-nettsteder**, velg **Når appen er i bruk** og slå på
   **Nøyaktig posisjon**.

Bruk alltid appen fra hjemskjermen på iPhone. Den har egen lagring, atskilt fra
Safari, så markeringer gjort i Safari vises ikke i appen (og omvendt).

**Android (Chrome):**

1. Åpne <https://b1lars1.github.io/lobsterApp/> i **Chrome**.
2. Trykk menyen **⋮** og velg **Installer app** (eller **Legg til på
   startsiden**), og bekreft.
3. Åpne appen fra ikonet. Tillat posisjon når du blir spurt, gjerne **Nøyaktig**.
4. Hvis GPS ikke virker: trykk lenge på app-ikonet → **App-info → Tillatelser →
   Posisjon**.

**Oppdateringer** kommer av seg selv: når du åpner appen med nett etter en ny
publisering, lastes den nye versjonen ned i bakgrunnen, og appen viser «Ny
versjon av appen er klar» med knappen **Last inn**. Markeringene dine beholdes.

## Kilder og kreditering

- **Dybdedata:** «Sjøkart – Dybdedata», © Kartverket, lisens
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  [Metadata i Geonorge](https://kartkatalog.geonorge.no/metadata/2751aacf-5472-4850-a208-3532a51c529a).
  Dataene er forenklet og klippet. De er ikke godkjent for navigasjon, og
  dybdene er referert til sjøkartnull.
- **Bakgrunnskart:** © Kartverket, lisens CC BY 4.0. WMTS-tjenesten
  `cache.kartverket.no` (laget `topograatone`, fra
  [GetCapabilities](https://cache.kartverket.no/v1/wmts/1.0.0/WMTSCapabilities.xml)).
  Flisene vises direkte fra tjenesten og lagres ikke av appen for bruk uten nett.
  Ifølge [Kartverkets vilkår](https://www.kartverket.no/api-og-data/vilkar-for-bruk)
  inneholder kartene Geovekst-data på zoomnivå 12–20, og kopiering krever særskilt
  tillatelse. Uten nett brukes derfor bare dybdedataene over.
- **Hummerfredningsområder:** «Hummer – fredningsområder», Fiskeridirektoratet.
  Inneholder data under Norsk lisens for offentlige data
  ([NLOD](https://data.norge.no/nlod/no/1.0)) tilgjengeliggjort av
  Fiskeridirektoratet. [Metadata i Geonorge](https://kartkatalog.geonorge.no/metadata/8901e1f8-b947-4f7d-819c-bf11e3e16a68).
- **Bunnhint:** «Marine naturtyper (HB19)», Miljødirektoratet. Inneholder data
  under Norsk lisens for offentlige data
  ([NLOD 2.0](https://data.norge.no/nlod/no/2.0)) tilgjengeliggjort av
  Miljødirektoratet. [Metadata i Geonorge](https://kartkatalog.geonorge.no/metadata/e4f40b02-7a32-4163-87af-d4121de48e6d).
- **Stedsnavn:** Sentralt stedsnavnregister, © Kartverket, lisens
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), hentet fra
  [Kartverkets stedsnavn-API](https://api.kartverket.no/stedsnavn/v1/).
- **Kartbibliotek:** [Leaflet](https://leafletjs.com/) (BSD 2-Clause).

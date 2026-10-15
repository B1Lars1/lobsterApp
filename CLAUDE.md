# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hummerkart Lillesand: en PWA for hummerfiske (dybdekart, GPS, teiner og fangst,
fredningsområder) pluss Python-skript som lager kartdataene og analyserer fangst.
README.md er brukerdokumentasjonen og forklarer hver funksjon og hvert skript i
detalj. Denne filen er det en agent trenger i tillegg.

## Språk og stil

- Alt er på norsk bokmål: kode, identifikatorer, kommentarer, tekst i appen,
  README og commit-meldinger. Brukeren skriver også norsk. Svar på norsk.
- Identifikatorer bruker ASCII i stedet for æ, ø og å: `naa`, `forste`, `oye`,
  `lagreSletting`, `HUMMER_GLANS`. Kommentarer og tekst bruker vanlige bokstaver.
- Commit-meldinger: kort tittel i imperativ («Legg til …», «Rett …», «Tegn …»),
  tom linje, så en forklaring på hvorfor. Commit rett på `main`, ingen grener eller PR.
- **README.md og CLAUDE.md skal alltid være oppdatert.** Oppdater dem i samme commit
  som endringen de beskriver:
  - README.md når noe brukeren merker endres: funksjoner, oppførsel, utseende,
    skript, kommandoer eller oppsett. Den beskriver hver funksjon for brukeren.
  - CLAUDE.md når noe en agent må vite endres: kommandoer, arkitektur, dataformater,
    konvensjoner, arbeidsflyt eller nye fallgruver du oppdager.
  - Sjekk begge før hver commit, og si fra til brukeren hva du har oppdatert.

## Kommandoer

Ingen byggesteg, ingen pakkehåndtering for JavaScript, ingen tester og ingen linter.
Appen i `app/` er statiske filer. README viser kommandoene for Windows/PowerShell
(`.\.venv\Scripts\python.exe`). På macOS/Linux er det `.venv/bin/python`.

```bash
python scripts/testserver.py            # appen på http://localhost:8000, uten mellomlagring
python scripts/lag_service_worker.py    # oppdater VERSJON og FILER i app/sw.js etter endringer i app/
python scripts/lag_ikoner.py            # app-ikonene (PNG) i app/ikoner/, krever bare Pillow
python scripts/sjekk_miljo.py           # sjekk Python-pakkene og at data/private ignoreres av git
```

- Dataskriptene (`last_ned_dybdedata.py`, `lag_dybdekart.py`, `lag_stedsnavn.py`,
  `lag_bunnhint.py`, `lag_fredningsomrader.py`, `analyser_fangst.py`) krever
  Python 3.14 og `requirements.txt` (geopandas osv.), det samme gjør `sjekk_miljo.py`.
  De tre første kommandoene over virker også med eldre Python 3, og `lag_ikoner.py`
  trenger bare `pip install pillow`.
- Simulert GPS for testing: `http://localhost:8000/?simuler=58.2405,8.3810`.
- Verifiser endringer i nettleseren med mobilstørrelse (ca. 375×812). Brukeren har
  iPhone og bruker appen fra hjemskjermen.
- Repoets vane er å kjøre `lag_service_worker.py` og committe den oppdaterte `sw.js`
  sammen med endringer i `app/`. Workflowen gjør det også ved publisering.
  Sjekksummen regnes med LF-linjeskift (git sjekker ut CRLF på Windows), så samme kode
  gir samme `VERSJON` på alle maskiner. Endres `VERSJON` uten at noe i `app/` er
  endret, er det en feil.

## Publisering

Push til `main` som endrer `app/` starter `.github/workflows/publiser.yml`, som
publiserer `app/` til GitHub Pages: <https://b1lars1.github.io/lobsterApp/>.
Telefonen får ny versjon neste gang appen åpnes med nett («Ny versjon av appen er
klar» → «Last inn»). Følg kjøringen med `gh run list` / `gh run watch <id>`.
Push publiserer altså rett til brukerens telefon: vis visuelle endringer (skjermbilde
eller skisse) og spør før du pusher dem.

På en ny maskin: git-identiteten i historikken er
`Ben Larsen <113174196+B1Lars1@users.noreply.github.com>`, og push over HTTPS krever
innlogging, for eksempel `gh auth login` og deretter `gh auth setup-git`.

## Arkitektur

**Moduler uten rammeverk.** `app/index.html` laster Leaflet (`app/vendor/`, globalt `L`)
som vanlig script og `js/app.js` som ES-modul. `app.js` setter opp kartet og kobler
sammen modulene. README har en tabell over hva hver fil gjør.

**Markeringer (teiner og fangst) er sentrum.** `markeringer.js` eksporterer én instans
`markeringer` som holder alle markeringer i minnet, lagrer hver endring i IndexedDB via
`lager.js` og varsler lyttere med `naarEndret()`. Lytterne er `kartmarkeringer.js`
(symbolene på kartet), `markeringsark.js` (arkene og listene), `oversikt.js`
(fangstoversikten, når den er åpen), `synk.js` (synkronisering kort tid etter
endringer) og merket på listeknappen i `app.js`.
Endre data gjennom metodene i `Markeringer`, aldri direkte i IndexedDB.

- IndexedDB `hummerkart`, versjon 2: tabellene `markeringer` og `slettinger`
  (`{ id, endret, markering }`, der `markering` er en kopi så den kan gjenopprettes).
  Ny tabell eller indeks: øk `DB_VERSJON` og la eksisterende data stå urørt i
  `onupgradeneeded`.
- En teinesetting går fra `tid` til `tatt_opp` (eller er i sjøen). «Sett ut igjen her»
  lager en ny teine med samme nummer. Fangst er egne markeringer med `teine_id`.
  Brukerens arbeidsflyt: å registrere fangst fra en teine i sjøen betyr at teinen er
  tatt opp i båten, så `_lagreUtkast` setter teinen til `tatt_opp` (på fangstens tid),
  også ved 0 hummer. «Tatt opp» (teinearket) og «Ta opp» (listen) åpner det samme
  fangstarket med 0 som utgangspunkt (`_taOppMedFangst`). Den settes ut igjen med «Sett teine», og `nesteTeinenummer()`
  gir da nummeret til teinen som sist ble tatt opp (siste 12 timer) hvis det er ledig.
  Tom teine er fangst med 0 beholdt og 0 satt ut (`erSjekk`), ikke en egen `kategori`:
  en ny kategori ville eldre versjoner av appen forkastet og så slettet fra GitHub ved
  neste synkronisering. Tidslinjen i `analyser_fangst.py` viser dem som hule ringer.
- Fangstoversikten (`oversikt.js`, åpnes fra teinelisten) regner teinesettinger,
  teinedøgn og hummer per teinedøgn på samme måte som `scripts/analyser_fangst.py`.
  Endres regnemåten ett sted, skal den endres begge steder. Oversikten viser bare
  hummersesongen (1. oktober–30. november, `hummersesong()` i `oversikt.js`, som også
  brukes til sesongtallet i teinelisten). Analysen bruker alle data. Tidslinjen er SVG laget som
  tekst. Den inneholder bare tall appen har regnet ut, aldri tekst fra brukeren (notater).
- Feltene i GeoJSON-eksporten (`FELT` i `markeringer.js`) er en kontrakt med
  `scripts/analyser_fangst.py` og brukerens analyser i GeoPandas. Ikke gi dem nye navn.

**Synkronisering** (`synk.js`) lagrer `markeringer.geojson` i brukerens private
GitHub-repo via GitHub-API-et, med token i `localStorage`. Sammenslåingen skjer i
`Markeringer.importer()`: nyeste `endret` vinner per id, og slettinger følger med som
`slettet: [{ id, endret }]`. Gjenoppretting gir ny `endret`, så den vinner over
slettingen. Flere telefoner deler filen, så formatet må forbli bakoverkompatibelt.

**Dybdekartet** (`dybdelag.js`) tegnes som canvas-fliser (`L.GridLayer`) fra
GeoJSON-filene i `app/data/` med en romlig indeks, ikke som Leaflet-vektorlag, fordi
dataene har flere hundre tusen koordinater. `dybdeoppslag.js` anslår dybde og bunnhint
i et punkt. Dataene lages av skriptene i `scripts/`, og `scripts/config.py` har felles
stier og kartutsnitt. `BBOX_WGS84` der må stemme med `DATAOMRADE` i `app/js/app.js`.

**Offline.** `app/sw.js` lagrer alle filene i `FILER` (generert av
`lag_service_worker.py`, nesten alle filer under `app/`). Lagret versjon brukes først,
unntatt på localhost, der nettverket brukes først så endringer vises med en gang.

**Symbolene på kartet** er `L.divIcon` med klassen `symbol` (`symbol teine`,
`symbol hummer`) og stiles i `app.css`, som også brukes i listene og arkene. Teinen er
en SVG-tegning (`app/ikoner/teine.svg` og `teine-opptatt.svg`, tegnet for hånd) som
bakgrunn, med nummeret som HTML oppå.

## Fallgruver

- Gi aldri Leaflet-markører (`.symbol`, `.gps-markor`) `position: relative`. Det
  overstyrer Leaflets `absolute`, og hvert symbol blir forskjøvet med høyden av
  symbolene før det. Det ga en feil der GPS-prikken og teinene havnet langt fra riktig
  sted når man zoomet ut.
- Ny fangst er et utkast (`_utkast` i `markeringsark.js`) til brukeren trykker «Ferdig».
  Først da kalles `markeringer.nyFangst()`. Lukkes arket på annen måte, forkastes den.
  Brukeren vil ikke at et feiltrykk skal bli liggende som en registrering. Et åpent
  utkast finnes ikke i `markeringer`, så `naarEndret` må ikke lukke arket da.
- Fangst registrert fra en teine får teinens posisjon og ligger under teinesymbolet
  på kartet (teiner har høyere z-indeks). Fangst må derfor kunne nås fra listene:
  teinearket og «Fangstregistreringer» i teinelisten (`_fangstRad` i `markeringsark.js`).
- Arkene er `<dialog>` åpnet med `showModal()`. Alt utenfor, også meldingene fra
  `melding.js`, er da utilgjengelig. En knapp i en melding kan ikke trykkes mens et
  ark er åpent.
- iPhone: dobbelttrykk når ikke fram til Leaflet, så `dobbelttrykk.js` oppdager det
  selv. Langt trykk er Leaflets `contextmenu` (marker et valgfritt sted). Kartet og
  knappene har `user-select: none`, ellers merker iPhone nærmeste tekst ved langt trykk.
  Appen fra hjemskjermen har egen lagring, atskilt fra Safari.
- Arkene må få plass uten å scrolle på en iPhone (ca. 375×812 minus hjem-streken nederst,
  ca. 34 px). Chrome viser ikke iPhone-feilene: Safari gir datofelt
  (`datetime-local`) en fast bredde som overser `width: 100%`, så arket ble bredere enn
  skjermen. Derfor har `.felt` `min-width: 0`, datofeltet mister Safaris utseende
  (`@supports (-webkit-touch-callout: none)`), og `.ark` har `overflow-x: hidden`.
- iOS 26 legger en myk uskarphet over de øverste ca. 30 punktene under statuslinjen i
  apper på hjemskjermen, og en nettside kan ikke slå den av. Alt som skal være skarpt
  øverst, plasseres med `var(--topp)` i `app.css` (statuslinjen + 36 px), ikke høyere.
- `app.js` holder innstillingene (`innstillinger.js`) i minnet og lagrer hele objektet
  ved hver endring. Andre moduler som husker noe i `localStorage`, bruker derfor egen
  nøkkel (som `hummerkart.synk`), ellers blir verdien overskrevet.
- Veiledningen for hjemskjermen (`hjemskjerm.js`) vises hver gang siden åpnes i
  nettleseren på telefon (brukeren vil det slik, ikke «vis igjen om en uke»). På PC
  skjules den. Mobilvisning i nettleseren gir Android-versjonen. For å teste
  iPhone-versjonen: overstyr `navigator.userAgent` og kall `visHjemskjermVeiledning()`.
  iPhone-trinnene gjelder Safari i iOS 26: Del ligger bak knappen med tre streker til
  venstre for adressefeltet.
- Når nettleserpanelet er skjult, bremses tidtakere. Test tidsavhengig oppførsel ved
  å simulere tid (`Date.now`) i stedet for å vente.

## Personvern

Repoet er offentlig. Ekte teineplasser og fangst skal aldri inn: `data/private/` og
`markeringer*.geojson` er ignorert av git, og testdata skal være oppdiktede punkter.
`data/raw/` og `data/processed/` lages på nytt av skriptene og ligger heller ikke i git.

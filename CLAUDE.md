# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hummerkart Lillesand: en PWA for hummerfiske (dybdekart, hummerpotensial, GPS, teiner
og fangst, fredningsområder, konto og lag i Firebase) pluss Python-skript som lager
kartdataene og analyserer fangst.
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
python scripts/testserver.py [port]     # appen på http://localhost:8000 (eller porten), uten mellomlagring
python scripts/lag_service_worker.py    # oppdater VERSJON og FILER i app/sw.js etter endringer i app/
python scripts/lag_ikoner.py            # app-ikonene (PNG) i app/ikoner/, krever bare Pillow
python scripts/sjekk_miljo.py           # sjekk Python-pakkene og at data/private ignoreres av git
```

- Dataskriptene (`last_ned_dybdedata.py`, `lag_dybdekart.py`, `lag_stedsnavn.py`,
  `lag_bunnhint.py`, `lag_hummerpotensial.py`, `lag_fredningsomrader.py`,
  `analyser_fangst.py`) krever Python 3.14 og `requirements.txt` (geopandas, rasterio
  osv.), det samme gjør `sjekk_miljo.py`. Rekkefølgen er `last_ned_dybdedata` →
  `lag_dybdekart` → `lag_bunnhint` og `lag_fredningsomrader` → `lag_hummerpotensial`,
  siden hvert skript leser det de forrige lagde (`data/processed/dybdedata_lillesand.gpkg`,
  `app/data/bunnhint.geojson`, `app/data/fredningsomrader.geojson`).
  De tre første kommandoene over virker også med eldre Python 3, og `lag_ikoner.py`
  trenger bare `pip install pillow`.
- Simulert GPS for testing: `http://localhost:8000/?simuler=58.2405,8.3810`. Kartet
  flytter seg til posisjonen bare hvis den er nærmere sjøen enn `NAER_SJOEN_M` (`naerSjoen`
  i `dybdeoppslag.js`, kalt fra `gps.js` ved første posisjon). Ellers står det på `START`
  (Skauerøya). Simuler et punkt på sjøen for å se deg selv.
- Uten innlogging kan ingenting lagres, og agenten kan ikke logge inn. Legg til
  `&utenkonto` for å teste teiner og fangst (virker bare på `localhost`, se `medKonto`).
- Verifiser endringer i nettleseren med mobilstørrelse (ca. 375×812). Brukeren har
  iPhone og bruker appen fra hjemskjermen.
- Steng alltid localhost når du er ferdig: stopp testserveren (Ctrl+C, eller stopp
  launch-konfigurasjonen eller bakgrunnsprosessen) på alle porter du har brukt (8000, 8001
  osv.), og sjekk at porten er ledig igjen. På Linux/macOS treffer `pkill -f testserver.py`
  også skallet som kjører kommandoen (mønsteret står i kommandolinjen). Bruk
  `pkill -f "[t]estserver.py"`.
- Repoets vane er å kjøre `lag_service_worker.py` og committe den oppdaterte `sw.js`
  sammen med endringer i `app/`. Workflowen gjør det også ved publisering.
  Sjekksummen regnes med LF-linjeskift (git sjekker ut CRLF på Windows), så samme kode
  gir samme `VERSJON` på alle maskiner. Endres `VERSJON` uten at noe i `app/` er
  endret, er det en feil.

## Publisering

Push til `main` som endrer `app/` starter `.github/workflows/publiser.yml`, som
publiserer `app/` til GitHub Pages: <https://b1lars1.github.io/lobsterApp/>.
Telefonen får ny versjon neste gang appen åpnes med nett («Ny versjon av appen er
klar» → «Last inn»). `gh` er ikke installert på brukerens maskin. Følg kjøringen med
det offentlige API-et (uten innlogging):
`curl -s "https://api.github.com/repos/B1Lars1/lobsterApp/actions/runs?per_page=3"`.
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
(fangstoversikten, når den er åpen), `sky.js` (synkronisering kort tid etter
endringer) og merket på listeknappen i `app.js`.
Endre data gjennom metodene i `Markeringer`, aldri direkte i IndexedDB.
`personer.js` eksporterer `personer` (hvem du er, laget, initialer og farger). `app.js`
oppdaterer den fra `sky`, og kartet, teinelisten og oversikten lytter med `naarEndret()`
(varsler bare når noe er endret, siden `sky` melder laget ved hver synkronisering).

- IndexedDB `hummerkart`, versjon 2: tabellene `markeringer` og `slettinger`
  (`{ id, endret, markering }`, der `markering` er en kopi så den kan gjenopprettes).
  Ny tabell eller indeks: øk `DB_VERSJON` og la eksisterende data stå urørt i
  `onupgradeneeded`.
- En teinesetting går fra `tid` til `tatt_opp` (eller er i sjøen). «Sett ut igjen her»
  lager en ny teine med samme nummer. `tid` kan endres i teinearket mens teinen står i
  sjøen (feltet «Satt», samme `tid`-gren i `_feltEndret` som fangstens tidspunkt), og
  tidspunkter frem i tid avvises der. Fangst er egne markeringer med `teine_id`.
  Brukerens arbeidsflyt: å registrere fangst fra en teine i sjøen betyr at teinen er
  tatt opp i båten, så `_lagreUtkast` setter teinen til `tatt_opp` (på fangstens tid),
  også ved 0 hummer. «Tatt opp» (teinearket) og «Ta opp» (listen) åpner det samme
  fangstarket med 0 som utgangspunkt (`_taOppMedFangst`). Den settes ut igjen med
  «Sett teine», og `nesteTeine()` gir da nummer og eier fra teinen du sist tok opp (siste
  12 timer: din egen, eller en annens du registrerte fangst fra) hvis nummeret er ledig for
  den eieren. «Sett ut igjen her» beholder også eieren.
  Tom teine er fangst med 0 beholdt og 0 satt ut (`erSjekk`), ikke en egen `kategori`:
  en ny kategori ville eldre versjoner av appen forkastet (`importer` godtar bare `teine`
  og `hummer`), og synkroniseringen ville ikke fått den med. Tidslinjen i
  `analyser_fangst.py` viser dem som hule ringer.
- Mistet teine: `merkMistet()` setter `status: 'tatt_opp'`, `tatt_opp` (når den ble meldt
  mistet) og `mistet: true`, ikke en ny status (eldre versjoner av appen gjør ukjente
  statuser om til `i_sjoen`). `funnetIgjen()` setter den i sjøen igjen. Mistede teiner
  vises alltid på kartet (rødt «?»), og `oversikt.js` og `analyser_fangst.py` holder dem
  utenfor fangstraten og andelen med hummer.
- **Eier i lag.** Teiner er personlige: `registrert_av` på en teine er eieren (kan endres
  i teinearket), og fangst hører til eieren av teinen den kom fra (`Markeringer.eierAv`,
  `legg_til_eier` i analysen), selv om `registrert_av` på fangsten er den som registrerte
  den. Ikke et nytt felt: reglene godtar bare feltene som finnes (`hasOnly`), og eldre versjoner
  av appen skriver hele dokumentet (`batch.set`) og ville slettet et felt de ikke kjenner.
  Uten lag er alt ditt. I et lag er en teine uten eier «Ukjent», ikke din (`personer.erMeg`).
  Hver eier har egne numre (`nummerBrukt(nummer, eier)`). De andres teiner har nummeret i
  personens farge (`personer.farge`, klassen `annen` med `--eier`) og initialene i navnet.
  Statistikken (oversikten, sesongtallet i teinelisten) viser bare dine (`erMin`), og
  «Ta opp mine» tar bare opp dine.
- Fangstoversikten (`oversikt.js`, åpnes fra teinelisten) regner teinesettinger,
  teinedøgn og hummer per teinedøgn på samme måte som `scripts/analyser_fangst.py`
  (`regnUt`). Endres regnemåten ett sted, skal den endres begge steder. Det samme gjelder
  hvem fangsten hører til. I et lag har oversikten «Mine | Laget»: «Laget» har en tabell
  per person og tidslinjen gruppert per person. Analysen viser det samme per person når
  flere har teiner i filen, og `--person` gir bare én persons teiner, som «Mine». Oversikten viser bare
  hummersesongen (1. oktober–30. november, `hummersesong()` i `oversikt.js`, som også
  brukes til sesongtallet i teinelisten). Analysen bruker alle data. Tidslinjen er SVG
  laget som tekst. Den inneholder bare tall appen har regnet ut, aldri tekst fra brukeren
  (notater). Se «Sikkerhet».
- Feltene i skyen og sikkerhetskopien (`FELT` i `markeringer.js`) er en kontrakt med
  `scripts/analyser_fangst.py`, `sikkerhetskopi.py` og brukerens analyser i GeoPandas.
  Ikke gi dem nye navn. Appen har ingen eksport lenger (fjernet sammen med Kartverkets
  topokart): analysen leser sikkerhetskopien, og «Gjenopprett fra fil» i
  innstillingene (`importer`, sperret med `medKonto`) er bare for nødsfall.

**Konto, lag og synkronisering** (`sky.js`, `konto.js`, `firebase.js`) bruker Firebase:
innlogging med e-post og passord, og Firestore med ett dokument per markering (feltene i
`FELT` pluss `lat`, `lon`, `slettet` og `oppdatert`) i et «rom»: `bruker:{uid}` →
`brukere/{uid}/markeringer/{id}`, eller `lag:{kode}` → `lag/{kode}/markeringer/{id}`.
En sletting er et dokument `{ id, endret, slettet: true }`.
- Telefonen er hovedkopien. `Sky` henter dokumenter med `oppdatert` (serverens tid)
  nyere enn `sistHentet`, slår dem sammen med `Markeringer.importer()` (nyeste `endret`
  vinner, slettinger følger med) og sender så det som er endret lokalt: der `endret`
  avviker fra kartet `kjent` (id → `endret` som ligger i rommet). Tilstanden ligger i
  `localStorage` under `hummerkart.sky` (`uid`, `rom`, `lag`, `sistHentet`, `kjent`).
  Gjenoppretting gir ny `endret`, så den vinner over slettingen.
- **Lag** er en felles logg: alle medlemmene leser og skriver alt. `lag/{kode}` har
  `{ navn, medlemmer: [uid], eposter: { uid: e-post }, opprettet, initialer: { uid: «BL» } }`,
  og koden (8 tegn, dokument-id-en) er invitasjonen. Hver setter sine egne initialer under
  Lag i innstillingene (`sky.settInitialer`). Reglene (`initialerOk`) tillater bare egne
  initialer (1–3 av A–Å), og at den som fjerner et medlem, fjerner medlemmets. Hver synkronisering spør først `finnLag(uid)` og bytter
  rom hvis medlemskapet er endret (`_byttRom`). Nytt rom tømmer `kjent`, så alt på
  telefonen sendes til det nye rommet: det du har, flyttes inn i laget, og går du ut,
  får kontoen en kopi. Én bruker er med i høyst ett lag. Reglene krever at e-posten den
  som oppretter eller blir med, skriver i `eposter`, er `request.auth.token.email`.
- `registrert_av` er en bruker-id, ikke e-post. `personer.kortnavn(uid)` gir initialene,
  ellers starten av e-posten i laget, så navnet forsvinner når noen går ut av laget
  (personvern, de blir «Tidligere medlem» og grå). Markeringer uten konto har `null`.
  `sikkerhetskopi.py` lagrer ikke initialene i `lag.json` ennå, så analysen bruker
  e-posten til de legges til der.
- I et lag slår tilgangsreglene opp i `lag/{kode}` (`get()`) for hver markering, og en
  batch tillater maks 20 slike oppslag. Derfor `BATCH_LAG = 15` i `firebase.js`.
- Gratiskvoten (Spark) er 50 000 lesinger og 20 000 skrivinger i døgnet, og 1 GiB. Hver
  synkronisering koster minst 2 lesinger (`finnLag` og spørringen, også når ingenting er
  endret), og hver telefon leser tilbake sine egne endringer. Ikke synkroniser oftere, og
  ikke les alt på nytt uten grunn. README («Hvor langt rekker gratisplanene?») har anslagene.
- `naarEndret` overses mens en synkronisering pågår, ellers ville importen av det som
  hentes, starte en ny synkronisering i det uendelige. Endringer gjort underveis sendes
  rett etterpå.
- Flere telefoner og eldre versjoner av appen deler dataene, så dokumentformatet må
  forbli bakoverkompatibelt. Et dokument har 20 felt (`FELT` + `lat`, `lon`, `slettet`,
  `oppdatert`), og reglene godtar bare dem (`d.keys().hasOnly([...])` i `gyldigMarkering`).
  Et nytt felt må legges til i listen der, og brukeren må publisere reglene før appen pushes.
  Reglene sjekker også at `registrert_av` er tekst eller null, og at `endret` er kort.
- Reglene for lag: et medlem kan fjerne andre, men ikke skrive noens e-post i `eposter`
  (`eposterOk`, bare fjerne e-posten til dem som fjernes). Dokumenter i laget kan bare
  slettes helt av det siste medlemmet (`slettAlle` i `fjernMedlem`, rett før laget slettes).
- Bryter ett dokument reglene, avvises hele batchen (`permission-denied`), og da stopper
  synkroniseringen for alt. Appen må derfor holde seg innenfor grensene i reglene:
  `MAKS_NOTAT` i `markeringer.js` (kuttes i `normaliser` og `oppdater`, `maxlength` i
  notatfeltene) er samme grense som `notat.size() <= 2000` i `firestore.rules`.
- Er man ikke logget inn, åpner `app.js` innloggingsarket når appen åpnes (første svar fra
  `sky`, se `sporOmInnlogging`), men ikke i nettleseren på telefon (`kanLeggesTil()`):
  der vises veiledningen for hjemskjermen, og innloggingen skal skje i appen derfra.
- Teiner og fangst kan bare lagres når man er logget inn (brukerens ønske). `medKonto` i
  `app.js` sperrer inngangene: «Sett teine», «Hummer her», langt trykk i kartet og
  «Gjenopprett fra fil» åpner innloggingen i stedet. Nye innganger som lager markeringer, må pakkes
  inn i `medKonto`. Før det første svaret fra `sky` (`innloggingKjent`) vises «Et øyeblikk».
  Sperren er ikke sikkerhet (dataene i skyen beskyttes av reglene), men gjør at alt havner
  i kontoen. Telefoner som er logget inn, husker det uten nett. Forsvinner Firebase, må
  sperren fjernes før nye telefoner kan brukes (se README i det private repoet).
- `firestore.rules` i roten er tilgangsreglene. De publiseres ikke automatisk: brukeren
  limer dem inn i Firebase-konsollen (Firestore → Rules). Si fra når de endres, og gi
  brukeren hele filen å lime inn. Appen må ikke publiseres før reglene er oppdatert, ellers
  får brukerne «Ingen tilgang til lagringen» (`permission-denied`).
- Firebase-SDK-et ligger i `app/vendor/firebase-12.19.0/` med importene endret til
  relative stier (se README der), så det virker uten nett. Bruk `firestore-lite`, ikke full
  Firestore: appen har egen lagring, og den fulle utgaven ville lagret alt en gang til.
- Agenten kan ikke logge inn eller opprette kontoer i Firebase (ekstern tjeneste). Test
  logikken med erstatninger: `Sky` tar `innlogging` og `tjeneste` som parametre
  (se `FirebaseInnlogging`/`FirestoreTjeneste` i `firebase.js` for hvilke metoder som
  trengs), og la brukeren teste ekte innlogging.
- Ber brukeren om å rette ekte data i laget: brukeren logger selv inn på `localhost:8000`
  i nettleserpanelet (skriv aldri inn passordet). Les og endre så gjennom appen med
  `await import('/js/markeringer.js')` (samme instans som appen) og metodene i
  `Markeringer`, så endringene synkroniseres som vanlig. Les og vis brukeren dataene først,
  kontroller antallene i skriptet før det endrer noe, og trykk «Synkroniser nå»
  (`#knapp-synk`) etterpå. Sikkerhetskopien og «Slettede markeringer» er angrestien.
  Data registrert før innlogging ble påkrevd, har `registrert_av` tom.
- Det finnes ingen analyse som henter fra Firestore. `analyser_fangst.py` leser
  sikkerhetskopien i `data/private/hummerkart-data/sikkerhetskopi/` (lagets fil
  hvis det er nøyaktig ett lag, ellers oppgir brukeren filen) etter `git pull`. Test den
  med oppdiktede data i samme format og `--ut` til en mappe utenfor repoet.
- **Sikkerhetskopi** ligger i det private repoet `B1Lars1/hummerkart-data` (klonet til
  `data/private/hummerkart-data/`, ignorert her): `sikkerhetskopi.py` kjøres av GitHub
  Actions der hver time fra 1. oktober til 15. desember og ellers hver natt (brukerens valg,
  fire `cron`-linjer i UTC), og lagrer alle rom som GeoJSON. Den committer bare når noe er
  endret, så ingen ny commit betyr ikke at den ikke kjørte (se Actions). Tidene står også i
  innstillingene (`oppdaterDatainfo` i `app.js`) og `personvern.html`. `gjenopprett.py`
  gjør en gammel kopi klar til import. Kopien er inkrementell: den spør hvert rom (fra
  kontoene i Auth og `lag`-samlingen) etter dokumenter med `oppdatert` nyere enn rommets
  merke i
  `sikkerhetskopi/tilstand.json`, og fletter dem inn i filene. Det fanger alt fordi
  reglene krever ny `oppdatert` ved hver skriving, og appen sletter dokumenter bare rom
  for rom (`slettAlle`, da forsvinner kontoen eller laget og filen fjernes). I et lag
  tillater reglene det bare for det siste medlemmet. Begynner
  appen å slette enkeltdokumenter, må kopien kjøres med `--full` (eller valget «Hent alt
  på nytt» i workflowen). Test endringer med en falsk Firestore, ikke ekte data. `sikkerhetskopi.py` har sin egen kopi av `FELT`: legges et felt til
  i `markeringer.js`, må det legges til der også. Tjenestekontoen er skrivebeskyttet, og
  nøkkelen ligger bare som hemmeligheten `FIREBASE_TJENESTEKONTO` i det private repoet.
  Ingenting fra det private repoet skal inn i dette offentlige repoet.

**Dybdekartet** (`dybdelag.js`) tegnes som canvas-fliser (`L.GridLayer`) fra
GeoJSON-filene i `app/data/` med en romlig indeks, ikke som Leaflet-vektorlag, fordi
dataene har flere hundre tusen koordinater. `dybdeoppslag.js` anslår dybde, bunnhint
og hummerpotensial i et punkt. Dataene lages av skriptene i `scripts/`, og
`scripts/config.py` har felles stier og kartutsnitt. `BBOX_WGS84` der må stemme med
`DATAOMRADE` i `app/js/app.js`. Kartutsnittet går fra Søgne (vestgrensen til Kristiansand
kommune, som dybdedataene for 4204 dekker) til Grimstad. Utvides det, må alle
dataskriptene kjøres på nytt i rekkefølgen over (`lag_dybdekart.py` tar ca. 10 min), og
appen lagrer alt for bruk uten nett (nå ca. 40 MB, ca. 120 MB minne i nettleseren). Mål
lastetid og minne etter en utvidelse. Ligger nytt område i en annen kommune, må den legges
til i `KOMMUNER` i `last_ned_dybdedata.py` og `lag_stedsnavn.py`. Nytt valgfritt
datalag: hent det i `lastDybdedata()` med `.catch(() => tom)`, så kartet virker uten
filen, og tegn det i `_tegnFlis` i riktig rekkefølge (soner, hummerpotensial, kurver,
bunnhint, tarekant, land, tekst). Skjær er tatt ut av `dybdetall.geojson` med vilje
(brukeren syntes symbolene forstyrret kartet). Ikke legg dem til igjen uten at brukeren
ber om det. De ligger fortsatt i GPKG-en (laget `skjer`).

**Hummerpotensialet** (`lag_hummerpotensial.py`) er et anslag som brukeren justerer etter
egen fangst: vektene og grensene står øverst i skriptet, og `analyser_fangst.py` leser
`app/data/hummerpotensial.geojson`, `tarekant.geojson` og rutenettet
`data/processed/hummerpotensial.tif` (dybde, helning, poengsum) for å vise fangst etter
potensial, helning og avstand til tarekanten. Flater og tarekant fjernes inne i
fredningsområdene (teiner er forbudt der), mens rutenettet beholder alle verdiene.
Endres klassene (`hoy`/`middels`) eller filnavnene, må `dybdelag.js`, `dybdeoppslag.js`
og `analyser_fangst.py` følge med.

**Offline.** `app/sw.js` lagrer alle filene i `FILER` (generert av
`lag_service_worker.py`, nesten alle filer under `app/`). Lagret versjon brukes først,
unntatt på localhost, der nettverket brukes først så endringer vises med en gang.

**Symbolene på kartet** er `L.divIcon` med klassen `symbol` (`symbol teine`,
`symbol hummer`) og stiles i `app.css`, som også brukes i listene og arkene. Teinen er
en SVG-tegning (`app/ikoner/teine.svg` og `teine-opptatt.svg`, tegnet for hånd) som
bakgrunn, med nummeret som HTML oppå.

## Fallgruver

- `hidden` virker ikke på et element som har `display` i `app.css` (for eksempel
  `.segment`, `.eier-valg`). Legg til en regel `…[hidden] { display: none; }`, ellers
  vises valget «Mine | Laget» også uten lag.
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
  ved hver endring. Derfor gjelder en ny standardverdi bare nye brukere. Skal den også
  gjelde dem som har brukt appen før, øk `VERSJON` i `innstillinger.js` og flytt verdien i
  `hentInnstillinger()` (slik bunnhint ble slått av i versjon 2). Andre moduler som
  husker noe i `localStorage`, bruker egen nøkkel (som `hummerkart.sky`), ellers blir
  verdien overskrevet når innstillingene lagres.
- Veiledningen for hjemskjermen (`hjemskjerm.js`) vises hver gang siden åpnes i
  nettleseren på telefon (brukeren vil det slik, ikke «vis igjen om en uke»). På PC
  skjules den. Mobilvisning i nettleseren gir Android-versjonen. For å teste
  iPhone-versjonen: overstyr `navigator.userAgent` og kall `visHjemskjermVeiledning()`.
  iPhone-trinnene gjelder Safari i iOS 26: Del ligger bak knappen med tre streker til
  venstre for adressefeltet.
- Når nettleserpanelet er skjult, bremses tidtakere. Test tidsavhengig oppførsel ved
  å simulere tid (`Date.now`) i stedet for å vente.
- Brukeren kan være logget inn med sin ekte konto på `localhost:8000` i
  nettleserpanelet, og alt der synkroniseres til laget og telefonene. Lag aldri testdata
  der. Test på `testserver.py 8001` (launch-konfigurasjonen «hummerkart-8001» i
  `.claude/launch.json`), som har egen lagring i nettleseren. Andre porter virker for alt
  unntatt innlogging (se «Sikkerhet»).

## Personvern

Repoet er offentlig. Ekte teineplasser og fangst skal aldri inn: `data/private/` og
`markeringer*.geojson` er ignorert av git, og testdata skal være oppdiktede punkter.
Brukernes data ligger i Firebase. Firebase-konfigurasjonen i `firebase.js` er offentlig
av natur, men tjenestekontonøkler (service account) og annet som gir adgang til alles
data, skal aldri inn i repoet. `app/personvern.html` må oppdateres hvis appen begynner å
lagre eller dele noe nytt om brukerne.
`data/raw/` og `data/processed/` lages på nytt av skriptene og ligger heller ikke i git.

## Sikkerhet

Brukeren vil ikke at noen skal stjele appen eller dataene. README har en oversikt over hva
som er offentlig («Sikkerhet: hva er offentlig, og hva er beskyttet»). Hold den oppdatert.

- `LICENSE` er «alle rettigheter forbeholdt». Repoet er offentlig bare fordi GitHub Pages
  er gratis for offentlige repoer. Ikke legg til en åpen lisens eller noe som gir andre
  rett til å bruke koden, uten at brukeren ber om det.
- Alt under `app/` er offentlig når det publiseres, også `hummerpotensial.geojson`. Legg
  aldri noe i `app/` som ikke skal kunne lastes ned av hvem som helst.
- Data fra skyen kan komme fra andre (et lag). Tekst fra brukere og skyen settes med
  `textContent` eller `dataset`, aldri inn i HTML. `fraMal` i `markeringsark.js`, SVG-en i
  `oversikt.js` og `kildeinfo` i `app.js` får bare konstanter, tall og egne filer. Id-er
  må passe `GYLDIG_ID` i `markeringer.js` (bokstaver, tall, `-`, `_`), ellers avvises de
  ved import. Samme regel står i `firestore.rules`. Navn fra laget (`personer.kortnavn`:
  initialer eller starten av e-posten) er også tekst fra skyen, så heller ikke `teinenavn()`
  kan settes inn i en mal (overskriften i fangstarket settes med `textContent`).
- `index.html` har Content-Security-Policy (meta-taggen øverst), og `personvern.html` en
  enklere. `script-src 'self'`: ingen script eller `onclick=` skrevet rett i HTML-en (temaet
  settes derfor av `js/tema.js`). `connect-src` tillater bare `*.googleapis.com` og
  `*.firebaseapp.com`. Tar appen i bruk en ny ekstern tjeneste, må den legges til der.
  Slår brukeren på reCAPTCHA eller App Check i Firebase, laster Firebase-SDK-et script fra
  `www.google.com`, og da stopper innloggingen til CSP-en er utvidet. Inline-stil er tillatt
  fordi `kartmarkeringer.js` og `oversikt.js` bruker `style=`. Test endringer med
  `securitypolicyviolation`-hendelser i nettleseren.
- `firestore.rules` er det eneste som beskytter dataene i Firebase. Hold reglene strenge,
  og si fra til brukeren at de må limes inn på nytt. Agenten har ingen emulator (verken
  Java eller Node er installert), så be brukeren teste dem i Rules Playground i konsollen.
- Firebase-innstillingene gjøres av brukeren i konsollen (README, «Oppsett i Firebase»,
  punkt 6–8). Alle er gjort (15. oktober 2026), og brukeren har totrinnsbekreftelse på
  Google og GitHub:
  - Nye kontoer er stengt, og appen har ikke «Opprett konto» (fjernet med `opprett()` i
    `firebase.js` og `opprettKonto()` i `sky.js`). Nye brukere legges til i konsollen
    (Add user, så «Glemt passord?» i appen). Skal folk kunne lage konto selv igjen, må
    sign-up slås på og koden hentes fra git-historikken (før «Fjern Opprett konto fra
    appen»).
  - API-nøkkelen virker bare fra `b1lars1.github.io`, `lobsterapp-aee59.firebaseapp.com`,
    `localhost:8000` og `localhost:8001`. Innlogging fra en annen port eller et annet domene
    feiler til brukeren legger adressen til på nøkkelen.
- Brukeren valgte å beholde repoet offentlig med `LICENSE` i stedet for å gjøre det privat
  eller legge hummerpotensialet bak innloggingen. Ikke foreslå det på nytt uten grunn.
- Aldri tokens, passord eller tjenestekontonøkler i repoet. `.gitignore` stopper de vanlige
  filnavnene for nøkler. Se gjennom `git diff --cached` før commit.

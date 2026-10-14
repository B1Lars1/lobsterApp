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
| 2 | Dybdedata: nedlasting og behandling | |
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

Skriptene for dybdedata og fredningsområder kommer i fase 2 og 5.

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

- **Dybdedata og bakgrunnskart:** © Kartverket. Datasett og lisens skrives inn
  her når dataene tas i bruk (fase 2 og 3).
- **Hummerfredningsområder:** Fiskeridirektoratet. Kilden bekreftes i fase 5.
- **Kartbibliotek:** [Leaflet](https://leafletjs.com/) (BSD 2-Clause).

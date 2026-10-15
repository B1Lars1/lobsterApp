"""Felles stier og konstanter for databehandlingsskriptene."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Data som ikke ligger i git (se .gitignore)
RAW_DIR = ROOT / "data" / "raw"              # nedlastede rådata
PROCESSED_DIR = ROOT / "data" / "processed"  # mellomprodukter i full oppløsning
PRIVATE_DIR = ROOT / "data" / "private"      # egne markeringer – aldri i git

# Ferdige, små filer som appen leser (ligger i git og publiseres)
APP_DATA_DIR = ROOT / "app" / "data"

# Kartutsnitt (lon_min, lat_min, lon_max, lat_max) i EPSG:4326: kysten fra Søgne (vestre
# grense av Kristiansand kommune, mot Lindesnes), forbi Kristiansand og Lillesand, til
# Grimstad. Husk å endre DATAOMRADE i app/js/app.js også.
BBOX_WGS84 = (7.65, 57.97, 8.70, 58.37)

# Sjødata tas bare med så langt ut som dette fra nærmeste land, holme eller skjær (meter).
SJO_AVSTAND_M = 3000

# Omtrent hele Agder-kysten, fra Lindesnes til Risør (for fredningsområdene)
AGDER_BBOX_WGS84 = (6.9, 57.9, 9.4, 58.8)

# Koordinatsystemer
CRS_WGS84 = "EPSG:4326"   # det appen (Leaflet/GeoJSON) bruker
CRS_UTM32 = "EPSG:25832"  # EUREF89 UTM sone 32 (Lillesand ligger i sone 32), i meter


def ensure_dirs() -> None:
    """Opprett datamappene (de finnes ikke etter en fersk kloning)."""
    for d in (RAW_DIR, PROCESSED_DIR, PRIVATE_DIR, APP_DATA_DIR):
        d.mkdir(parents=True, exist_ok=True)

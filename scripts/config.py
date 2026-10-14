"""Felles stier og konstanter for databehandlingsskriptene."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Data som ikke ligger i git (se .gitignore)
RAW_DIR = ROOT / "data" / "raw"              # nedlastede rådata
PROCESSED_DIR = ROOT / "data" / "processed"  # mellomprodukter i full oppløsning
PRIVATE_DIR = ROOT / "data" / "private"      # egne markeringer – aldri i git

# Ferdige, små filer som appen leser (ligger i git og publiseres)
APP_DATA_DIR = ROOT / "app" / "data"

# Kartutsnitt for Lillesand (lon_min, lat_min, lon_max, lat_max) i EPSG:4326
BBOX_WGS84 = (8.28, 58.17, 8.52, 58.29)

# Omtrent hele Agder-kysten, fra Lindesnes til Risør (for fredningsområdene)
AGDER_BBOX_WGS84 = (6.9, 57.9, 9.4, 58.8)

# Koordinatsystemer
CRS_WGS84 = "EPSG:4326"   # det appen (Leaflet/GeoJSON) bruker
CRS_UTM32 = "EPSG:25832"  # EUREF89 UTM sone 32 (Lillesand ligger i sone 32), i meter


def ensure_dirs() -> None:
    """Opprett datamappene (de finnes ikke etter en fersk kloning)."""
    for d in (RAW_DIR, PROCESSED_DIR, PRIVATE_DIR, APP_DATA_DIR):
        d.mkdir(parents=True, exist_ok=True)

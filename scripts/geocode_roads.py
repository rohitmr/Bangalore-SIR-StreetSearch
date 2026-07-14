#!/usr/bin/env python3
"""Geocode Jayamahal (A087) road/locality names via OSM Nominatim.

Respects Nominatim's usage policy: one request/second, custom User-Agent,
results cached to disk so re-runs only fetch new/failed entries.
"""
import json
import re
import time
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
ROAD_INDEX = DATA_DIR / "road_index.json"
CACHE_FILE = DATA_DIR / "geocache.json"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "jayamahal-2002-electoral-roll-finder/1.0 (civic, non-commercial lookup tool)"}

# Rough bounding box around the Jayamahal / North Bengaluru area, used to bias results.
# left, top, right, bottom (lon/lat)
VIEWBOX = "77.55,13.05,77.65,12.95"

# Fallback centroid for the constituency, used when no query variant resolves.
FALLBACK_CENTER = {"lat": 12.9995, "lon": 77.5985}


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {}


def save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, indent=2))


def query_variants(road):
    cleaned = re.sub(r"\s+", " ", road).strip()
    return [
        f"{cleaned}, Bengaluru, Karnataka, India",
        f"{cleaned}, Jayamahal, Bengaluru, Karnataka, India",
        f"{cleaned}, Bengaluru",
    ]


def geocode_one(road):
    for q in query_variants(road):
        try:
            resp = requests.get(
                NOMINATIM_URL,
                params={
                    "q": q,
                    "format": "jsonv2",
                    "limit": 1,
                    "viewbox": VIEWBOX,
                    "bounded": 1,
                },
                headers=HEADERS,
                timeout=15,
            )
            resp.raise_for_status()
            results = resp.json()
        except Exception as e:
            results = []
            print(f"  ! error for query '{q}': {e}")
        time.sleep(1.1)
        if results:
            r = results[0]
            return {
                "lat": float(r["lat"]),
                "lon": float(r["lon"]),
                "displayName": r.get("display_name"),
                "queryUsed": q,
                "resolved": True,
            }
    return {
        "lat": FALLBACK_CENTER["lat"],
        "lon": FALLBACK_CENTER["lon"],
        "displayName": None,
        "queryUsed": None,
        "resolved": False,
    }


def main():
    roads = json.loads(ROAD_INDEX.read_text())
    cache = load_cache()

    todo = [r["road"] for r in roads if r["road"] not in cache]
    print(f"{len(roads)} roads total, {len(todo)} need geocoding")

    for i, road in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {road}")
        cache[road] = geocode_one(road)
        if i % 20 == 0:
            save_cache(cache)

    save_cache(cache)
    resolved = sum(1 for v in cache.values() if v["resolved"])
    print(f"Done. {resolved}/{len(cache)} resolved to a specific place, "
          f"{len(cache) - resolved} fell back to the constituency center.")


if __name__ == "__main__":
    main()

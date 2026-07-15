#!/usr/bin/env python3
"""Geocode a constituency's road/locality names via OSM Nominatim.

Respects Nominatim's usage policy: one request/second, custom User-Agent,
results cached to disk so re-runs only fetch new/failed entries.

Usage:
    python3 geocode_roads.py --constituency A087
"""
import argparse
import json
import re
import time
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
CONSTITUENCIES_FILE = DATA_DIR / "constituencies.json"
GEOCODE_CONFIG_FILE = Path(__file__).resolve().parent / "geocode_config.json"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "bbmp-sir-2002-electoral-roll-finder/1.0 (civic, non-commercial lookup tool)"}


def load_constituency(constituency_id):
    registry = json.loads(CONSTITUENCIES_FILE.read_text())
    for c in registry:
        if c["id"] == constituency_id:
            return c
    raise SystemExit(f"Unknown constituency '{constituency_id}' — check {CONSTITUENCIES_FILE}")


def load_geocode_config(constituency_id):
    configs = json.loads(GEOCODE_CONFIG_FILE.read_text())
    if constituency_id not in configs:
        raise SystemExit(
            f"No geocoding config for '{constituency_id}' in {GEOCODE_CONFIG_FILE} "
            "— add a viewbox + fallbackCenter for it before geocoding."
        )
    return configs[constituency_id]


def load_cache(cache_file):
    if cache_file.exists():
        return json.loads(cache_file.read_text())
    return {}


def save_cache(cache_file, cache):
    cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=2))


def query_variants(road, constituency_name):
    cleaned = re.sub(r"\s+", " ", road).strip()
    return [
        f"{cleaned}, Bengaluru, Karnataka, India",
        f"{cleaned}, {constituency_name}, Bengaluru, Karnataka, India",
        f"{cleaned}, Bengaluru",
    ]


def is_confirmable(pin_status):
    """A road with no pinStatus at all (older workbooks, e.g. A087) is fair game for
    geocoding as before. A road WITH a pinStatus that isn't explicitly "confirmed" means
    the verification pass already decided not to assert a location for it — respect
    that instead of letting a same-named Nominatim hit override that call."""
    if pin_status is None:
        return True
    return "confirm" in pin_status.lower()


def geocode_one(road, constituency_name, viewbox, fallback_center):
    for q in query_variants(road, constituency_name):
        try:
            resp = requests.get(
                NOMINATIM_URL,
                params={
                    "q": q,
                    "format": "jsonv2",
                    "limit": 1,
                    "viewbox": viewbox,
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
        "lat": fallback_center["lat"],
        "lon": fallback_center["lon"],
        "displayName": None,
        "queryUsed": None,
        "resolved": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--constituency", required=True, help="Constituency ID, e.g. A087")
    args = parser.parse_args()

    constituency = load_constituency(args.constituency)
    geo_config = load_geocode_config(args.constituency)

    out_dir = DATA_DIR / args.constituency
    road_index_file = out_dir / "road_index.json"
    cache_file = out_dir / "geocache.json"
    if not road_index_file.exists():
        raise SystemExit(f"{road_index_file} not found — run export_data.py for this constituency first")

    roads = json.loads(road_index_file.read_text())
    cache = load_cache(cache_file)

    todo = [r for r in roads if r["road"] not in cache]
    skipped = sum(1 for r in todo if not is_confirmable(r.get("pinStatus")))
    print(f"{constituency['name']} ({constituency['id']}): {len(roads)} roads total, {len(todo)} need geocoding "
          f"({skipped} pre-marked as not-for-pinning by the verification pass, will skip Nominatim)")

    for i, r in enumerate(todo, 1):
        road = r["road"]
        if not is_confirmable(r.get("pinStatus")):
            cache[road] = {
                "lat": geo_config["fallbackCenter"]["lat"],
                "lon": geo_config["fallbackCenter"]["lon"],
                "displayName": None,
                "queryUsed": None,
                "resolved": False,
                "note": f"Verification pass marked this as \"{r['pinStatus']}\" — no confirmed pin asserted.",
            }
            continue
        print(f"[{i}/{len(todo)}] {road}")
        cache[road] = geocode_one(road, constituency["name"], geo_config["viewbox"], geo_config["fallbackCenter"])
        if i % 20 == 0:
            save_cache(cache_file, cache)

    save_cache(cache_file, cache)
    resolved = sum(1 for v in cache.values() if v["resolved"])
    print(f"Done. {resolved}/{len(cache)} resolved to a specific place, "
          f"{len(cache) - resolved} fell back to the constituency center.")


if __name__ == "__main__":
    main()

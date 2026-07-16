#!/usr/bin/env python3
"""Geocode a constituency's road/locality names via OSM Nominatim.

Respects Nominatim's usage policy: one request/second, custom User-Agent,
results cached to disk so re-runs only fetch new/failed entries.

When a workbook provides a Cluster Zone per road, a resolved coordinate is
cross-checked against that zone's own geocoded anchor point and rejected as
a likely wrong-neighborhood match if it's implausibly far away — instead of
trusting whatever Nominatim returns for a same-named place. Roads with no
cluster zone AND a workbook pin status that isn't "confirmed" are left
unresolved, since there's nothing to verify the guess against.

Usage:
    python3 geocode_roads.py --constituency A087
"""
import argparse
import json
import re
import time
from math import radians, sin, cos, sqrt, atan2
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parents[1] / "data"
CONSTITUENCIES_FILE = DATA_DIR / "constituencies.json"
GEOCODE_CONFIG_FILE = Path(__file__).resolve().parent / "geocode_config.json"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
HEADERS = {"User-Agent": "bbmp-sir-2002-electoral-roll-finder/1.0 (civic, non-commercial lookup tool)"}

MAX_ZONE_DISTANCE_KM = 2.5


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
    the verification pass didn't assert a location for it — if there's also no cluster
    zone to independently verify a guess against, respect that and don't geocode."""
    if pin_status is None:
        return True
    return "confirm" in pin_status.lower()


def nominatim_search(q, viewbox):
    try:
        resp = requests.get(
            NOMINATIM_URL,
            params={"q": q, "format": "jsonv2", "limit": 1, "viewbox": viewbox, "bounded": 1},
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        results = resp.json()
    except Exception as e:
        results = []
        print(f"  ! error for query '{q}': {e}")
    time.sleep(1.1)
    return results


def geocode_one(road, constituency_name, viewbox, fallback_center):
    for q in query_variants(road, constituency_name):
        results = nominatim_search(q, viewbox)
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


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return r * 2 * atan2(sqrt(a), sqrt(1 - a))


def zone_segments(zone_text):
    cleaned = re.sub(r"^[A-Za-z\s-]+:\s*", "", zone_text)
    return [s.strip() for s in cleaned.split("/") if s.strip()]


def resolve_zone_anchors(road_index, viewbox, fallback_center):
    """Geocode each distinct cluster-zone string once, so individual road results
    can be checked against it. Falls back to the constituency center for any zone
    Nominatim can't place at all (rare, small locality names)."""
    zones = set()
    for r in road_index:
        cz = r.get("clusterZone")
        if not cz:
            continue
        for z in cz.split("|"):
            zones.add(z.strip())

    anchors = {}
    for zone in sorted(zones):
        anchor = None
        for seg in zone_segments(zone):
            results = nominatim_search(f"{seg}, Bengaluru, Karnataka, India", viewbox)
            if results:
                r0 = results[0]
                anchor = (float(r0["lat"]), float(r0["lon"]))
                break
        anchors[zone] = anchor or (fallback_center["lat"], fallback_center["lon"])
        print(f"  zone anchor: {zone!r} -> {anchors[zone]}")
    return anchors


def verify_against_zones(result, cluster_zone, zone_anchors):
    """Downgrade a Nominatim hit to unresolved if it's implausibly far from every
    zone the road is supposed to be in."""
    zones = [z.strip() for z in cluster_zone.split("|") if z.strip()]
    distances = [
        haversine_km(result["lat"], result["lon"], *zone_anchors[z])
        for z in zones
        if z in zone_anchors
    ]
    if not distances:
        return result
    min_dist = min(distances)
    if min_dist > MAX_ZONE_DISTANCE_KM:
        result["resolved"] = False
        result["note"] = (
            f"Geocoded to \"{result['displayName']}\" but that's {min_dist:.1f}km from its "
            f"expected cluster zone ({zones[0]}) — rejected as a likely wrong-neighborhood match."
        )
    else:
        result["note"] = f"Within {min_dist:.1f}km of its expected cluster zone ({zones[0]})."
    return result


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

    zone_anchors = {}
    if any(r.get("clusterZone") for r in roads):
        print("Resolving cluster-zone anchors...")
        zone_anchors = resolve_zone_anchors(roads, geo_config["viewbox"], geo_config["fallbackCenter"])

    todo = [r for r in roads if r["road"] not in cache]
    print(f"{constituency['name']} ({constituency['id']}): {len(roads)} roads total, {len(todo)} need geocoding")

    rejected_by_zone_check = 0
    for i, r in enumerate(todo, 1):
        road = r["road"]
        cluster_zone = r.get("clusterZone")
        pin_status = r.get("pinStatus")

        if not cluster_zone and not is_confirmable(pin_status):
            cache[road] = {
                "lat": geo_config["fallbackCenter"]["lat"],
                "lon": geo_config["fallbackCenter"]["lon"],
                "displayName": None,
                "queryUsed": None,
                "resolved": False,
                "note": f"Verification pass marked this as \"{pin_status}\" — no cluster zone to verify a guess against.",
            }
            continue

        print(f"[{i}/{len(todo)}] {road}")
        result = geocode_one(road, constituency["name"], geo_config["viewbox"], geo_config["fallbackCenter"])
        if result["resolved"] and cluster_zone:
            was_resolved = result["resolved"]
            result = verify_against_zones(result, cluster_zone, zone_anchors)
            if was_resolved and not result["resolved"]:
                rejected_by_zone_check += 1
        cache[road] = result
        if i % 20 == 0:
            save_cache(cache_file, cache)

    save_cache(cache_file, cache)
    resolved = sum(1 for v in cache.values() if v["resolved"])
    print(f"Done. {resolved}/{len(cache)} resolved to a specific place, "
          f"{len(cache) - resolved} fell back to the constituency center "
          f"({rejected_by_zone_check} of those rejected by the cluster-zone distance check).")


if __name__ == "__main__":
    main()

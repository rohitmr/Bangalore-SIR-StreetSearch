# Jayamahal 2002 Electoral Roll Finder

A small static website that helps people in the former Jayamahal Assembly
Constituency (A087, Bengaluru) find the correct **2002 electoral-roll part
number** for their road, then jump straight to the official PDF on
[ceo.karnataka.gov.in](https://ceo.karnataka.gov.in/voter_list.html).

This is an independent, community-built tool — not run by the Election
Commission or CEO Karnataka. Road-to-part mappings were reconstructed by OCR
and manual verification of the original scanned rolls and may contain errors;
always confirm against the linked PDF page.

## Features

- **Search by road/locality** — fuzzy search across ~210 verified
  road/locality names (current and historical), each mapped to its part
  number(s).
- **Map** — approximate pins (geocoded via OpenStreetMap) for every indexed
  road/locality, with popups linking to the matching part's PDF.
- **Lookup by part number** — jump directly to any of the 197 parts.
- **Browse all parts** — a full grid of all 197 parts with a preview image
  and PDF link each.

## Structure

```
site/
  index.html          entry point
  css/style.css
  js/app.js
  data/
    road_index.json      road/locality -> part number(s), confidence, links
    part_summary.json    per-part roads, official PDF URL
    bbmp_gazetteer.json  official BBMP street list (cross-reference)
    needs_review.json    entries flagged as uncertain
    geocache.json        cached lat/lon per road/locality (generated)
  images/               first-page preview PNG per part (A0870NNN.png)
  scripts/
    export_data.py       regenerate the data/*.json files from the xlsx
    geocode_roads.py     (re)geocode road_index.json into geocache.json
```

## Regenerating data

The xlsx source of truth lives one level above `site/` (not committed to
this repo). To rebuild the JSON data after editing it:

```bash
python3 scripts/export_data.py
python3 scripts/geocode_roads.py   # only needed if road names changed
```

## Running locally

```bash
cd site
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly won't work —
the browser blocks `fetch()` of local JSON files under the `file://`
scheme.)

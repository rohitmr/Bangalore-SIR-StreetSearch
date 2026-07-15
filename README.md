# BBMP SIR 2002 Electoral Roll Finder

A small static website that helps people in Bengaluru's BBMP assembly
constituencies find the correct **2002 electoral-roll part number** for
their road, then jump straight to the official PDF. PDFs originate from
[ceo.karnataka.gov.in](https://ceo.karnataka.gov.in/voter_list.html) and are
mirrored on our own S3 bucket, constituency by constituency, so links stay
reliable even when the source site doesn't.

This is an independent, community-built tool — not run by the Election
Commission or CEO Karnataka. Road-to-part mappings were reconstructed by OCR
and manual verification of the original scanned rolls and may contain errors;
always confirm against the linked PDF page.

Constituencies are added one at a time as their rolls are OCR'd and verified;
`data/constituencies.json` lists all 12 target constituencies (A076–A087),
and a constituency shows up on the site as soon as its `data/{id}/` folder
exists — no code changes needed.

## Features

- **Search by road/locality** — fuzzy search across every constituency's
  verified road/locality names (current and historical) at once, each
  result tagged with which constituency it's in.
- **Map** — approximate pins (geocoded via OpenStreetMap) for every indexed
  road/locality across all constituencies, with popups linking to the
  matching part's PDF.
- **Lookup by part number** — part numbers restart at 1 per constituency, so
  pick a constituency first, then jump to any of its parts.
- **Browse all parts** — a full grid of a constituency's parts with a preview
  image and PDF link each.

## Structure

```
site/
  index.html          entry point
  css/style.css
  js/app.js
  data/
    constituencies.json   registry of all 12 constituencies (id, AC no., name, part count, PDF folder)
    {id}/                  one folder per constituency with data (e.g. A087/), absent = not added yet
      road_index.json      road/locality -> part number(s), confidence, links
      part_summary.json    per-part roads, official PDF URL
      bbmp_gazetteer.json  official BBMP street list (cross-reference)
      needs_review.json    entries flagged as uncertain
      geocache.json        cached lat/lon per road/locality (generated)
  images/               first-page preview PNG per part (e.g. A0870NNN.png) — stays flat,
                         filenames already embed the AC number so constituencies never collide
  scripts/
    export_data.py        regenerate a constituency's data/{id}/*.json files from its xlsx
    geocode_roads.py       (re)geocode a constituency's road_index.json into its geocache.json
    geocode_config.json    per-constituency Nominatim viewbox + fallback center (geocoding-only)
```

## Adding a new constituency

1. Add/confirm its entry in `data/constituencies.json` (id, AC number, name,
   part count, PDF folder — the PDF folder is descriptive metadata pointing
   at its source on ceo.karnataka.gov.in and isn't used to build links).
2. Add its viewbox + fallback center to `scripts/geocode_config.json`.
3. Run the two scripts below with `--constituency <ID>`.
4. Drop its preview PNGs into `images/` (same `{ID}0NNN.png` naming as A087).
5. Upload its full PDFs to `s3://bbmp-sir-2002/{ID}-PDFs/{code}.pdf` — the
   site links directly to that bucket instead of ceo.karnataka.gov.in, so a
   constituency's official-PDF links won't resolve until its folder is there.

No front-end code changes are needed — `app.js` loads whatever constituencies
have a `data/{id}/` folder and skips the rest.

## Regenerating data

The xlsx source of truth for each constituency lives one level above `site/`
(not committed to this repo). To rebuild a constituency's JSON data after
editing it:

```bash
python3 scripts/export_data.py --constituency A087 --xlsx ../Jayamahal_A087_2002_Road_Part_Index_Second_Pass.xlsx
python3 scripts/geocode_roads.py --constituency A087   # only needed if road names changed
```

## Running locally

```bash
cd site
python3 -m http.server 8000
```

Then open http://localhost:8000. (Opening `index.html` directly won't work —
the browser blocks `fetch()` of local JSON files under the `file://`
scheme.)

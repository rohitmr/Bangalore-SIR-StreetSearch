#!/usr/bin/env python3
"""Export the Jayamahal 2002 electoral roll index from xlsx into JSON for the static site."""
import json
import re
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
XLSX = ROOT / "Jayamahal_A087_2002_Road_Part_Index_Second_Pass.xlsx"
OUT_DIR = Path(__file__).resolve().parents[1] / "data"

OFFICIAL_PDF_TEMPLATE = "https://ceo.karnataka.gov.in/uploads/BBMP/AC%2087/{code}.pdf"


def sheet_rows(ws):
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    for r in rows:
        if all(v is None for v in r):
            continue
        yield dict(zip(header, r))


def parse_part_numbers(value):
    if not value:
        return []
    return [int(x.strip()) for x in str(value).split(",") if x.strip()]


def main():
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)

    road_index = []
    for row in sheet_rows(wb["Road Index"]):
        parts = parse_part_numbers(row.get("Part Number(s)"))
        road_index.append({
            "road": row.get("Road / Locality"),
            "parts": parts,
            "partCount": row.get("Part Count"),
            "matchedEntries": row.get("Matched Entries"),
            "minConfidence": row.get("Minimum Confidence"),
            "status": row.get("Status"),
            "numberedRoadDetails": row.get("Numbered Roads / Details"),
            "mapAreaCheck": row.get("Map / Area Check"),
            "evidenceUrl": row.get("Evidence URL"),
            "googleMapsSearch": row.get("Google Maps Search"),
        })

    part_summary = []
    for row in sheet_rows(wb["Part Summary"]):
        part_no = row.get("Part Number")
        code = row.get("Part Code")
        part_summary.append({
            "partNumber": part_no,
            "partCode": code,
            "roads": row.get("Roads / Localities"),
            "numberedRoadDetails": row.get("Numbered Road Details"),
            "acceptedEntries": row.get("Accepted Entries"),
            "historicalOnlyEntries": row.get("Historical-only Entries"),
            "needsReview": row.get("Needs Review"),
            "excludedOcr": row.get("Excluded OCR"),
            "sourceImage": row.get("Source Image"),
            "officialPdfUrl": OFFICIAL_PDF_TEMPLATE.format(code=code),
        })

    bbmp_gazetteer = []
    for row in sheet_rows(wb["BBMP Gazetteer"]):
        bbmp_gazetteer.append({
            "slNo": row.get("BBMP Sl No"),
            "wardNo": row.get("Ward No"),
            "officialStreetName": row.get("Official Street Name"),
            "pdfPage": row.get("PDF Page"),
            "officialPdf": row.get("Official PDF"),
        })

    needs_review = list(sheet_rows(wb["Needs Review"]))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "road_index.json").write_text(json.dumps(road_index, ensure_ascii=False, indent=2))
    (OUT_DIR / "part_summary.json").write_text(json.dumps(part_summary, ensure_ascii=False, indent=2))
    (OUT_DIR / "bbmp_gazetteer.json").write_text(json.dumps(bbmp_gazetteer, ensure_ascii=False, indent=2))
    (OUT_DIR / "needs_review.json").write_text(json.dumps(needs_review, ensure_ascii=False, indent=2, default=str))

    print(f"road_index: {len(road_index)} entries")
    print(f"part_summary: {len(part_summary)} entries")
    print(f"bbmp_gazetteer: {len(bbmp_gazetteer)} entries")
    print(f"needs_review: {len(needs_review)} entries")


if __name__ == "__main__":
    main()

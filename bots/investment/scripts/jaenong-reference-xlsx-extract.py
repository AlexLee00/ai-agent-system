#!/usr/bin/env python3
"""Extract cached cell values and formulas from an xlsx using the stdlib only."""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": REL_NS, "p": PKG_REL_NS}
SHEET_COLUMNS = {
    "판단부분": ("B", "N", 1000),
    "종목별 데이터": ("B", "P", 2000),
    "기준시트의 사본": ("F", "G", 100),
}


def xml_text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return "".join(node.itertext())


def parse_scalar(raw: str | None):
    if raw is None or raw == "":
        return None
    try:
        number = float(raw)
        return int(number) if number.is_integer() else number
    except ValueError:
        return raw


def read_shared_strings(book: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in book.namelist():
        return []
    root = ET.fromstring(book.read("xl/sharedStrings.xml"))
    return [xml_text(item) for item in root.findall("m:si", NS)]


def cell_value(cell: ET.Element, shared_strings: list[str]):
    cell_type = cell.attrib.get("t", "n")
    value = cell.find("m:v", NS)
    raw = value.text if value is not None else None
    if cell_type == "s":
        index = int(raw or 0)
        return shared_strings[index] if 0 <= index < len(shared_strings) else None
    if cell_type == "inlineStr":
        return xml_text(cell.find("m:is", NS))
    if cell_type == "b":
        return raw == "1"
    if cell_type == "e":
        return None
    if cell_type in {"str", "d"}:
        return raw
    return parse_scalar(raw)


def split_address(address: str) -> tuple[str, int] | None:
    match = re.fullmatch(r"([A-Z]+)(\d+)", address)
    return (match.group(1), int(match.group(2))) if match else None


def include_cell(sheet_name: str, address: str) -> bool:
    parts = split_address(address)
    if not parts or sheet_name not in SHEET_COLUMNS:
        return False
    column, row = parts
    first, last, max_row = SHEET_COLUMNS[sheet_name]
    return first <= column <= last and row <= max_row


def include_formula(sheet_name: str, address: str) -> bool:
    parts = split_address(address)
    if not parts:
        return False
    column, row = parts
    if sheet_name == "판단부분":
        return address in {"E3", "F3", "E6", "F6", "E7", "F7"} or (column == "C" and row >= 11)
    return sheet_name == "종목별 데이터" and column == "D" and row >= 5


def extract(path: str) -> dict:
    with zipfile.ZipFile(path) as book:
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        relationships = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        target_by_id = {
            rel.attrib["Id"]: rel.attrib["Target"]
            for rel in relationships.findall("p:Relationship", NS)
        }
        shared_strings = read_shared_strings(book)
        sheets = {}
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            name = sheet.attrib["name"]
            if name not in SHEET_COLUMNS:
                continue
            relation_id = sheet.attrib[f"{{{REL_NS}}}id"]
            target = target_by_id[relation_id].lstrip("/")
            sheet_path = target if target.startswith("xl/") else f"xl/{target}"
            root = ET.fromstring(book.read(sheet_path))
            cells = {}
            for node in root.findall(".//m:sheetData/m:row/m:c", NS):
                address = node.attrib.get("r")
                if not address or not include_cell(name, address):
                    continue
                formula_node = node.find("m:f", NS)
                value = cell_value(node, shared_strings)
                formula = formula_node.text if formula_node is not None and include_formula(name, address) else None
                if value is None and formula is None:
                    continue
                cells[address] = {
                    "value": value,
                    "formula": formula,
                }
            sheets[name] = {"cells": cells}
        return {"sheets": sheets}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: jaenong-reference-xlsx-extract.py <xlsx>", file=sys.stderr)
        return 2
    print(json.dumps(extract(sys.argv[1]), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

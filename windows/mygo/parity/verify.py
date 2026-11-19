#!/usr/bin/env python3
"""Validate the frozen Web inventory and score recorded Windows acceptance runs."""

import argparse
import csv
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASELINE = "c62ad1c01702c32b6224099d8587d12262aa31e9"
ROUTE_EXCLUSIONS = {
    r"/^#\/admin$/": "@站务管理",
    r"/^#\/announce\/new$/": "@站务公告发布",
    r"/^#\/announce\/(\d+)$/": "@站务公告编辑",
}


def read_table(name, columns):
    with (HERE / name).open(encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source, delimiter="\t")
        if reader.fieldnames != columns.split():
            raise ValueError(f"Invalid columns in {name}")
        rows = list(reader)
    if not rows or any(None in row or not all(row.values()) for row in rows):
        raise ValueError(f"Empty fields or extra columns in {name}")
    return rows


def inventory():
    rows = read_table(
        "web-flows.tsv", "id stage area required web_entry prerequisite acceptance"
    )
    flows = {}
    for row in rows:
        flow_id = row["id"]
        if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)+", flow_id) or flow_id in flows:
            raise ValueError(f"Invalid or duplicate flow ID {flow_id}")
        if row["stage"] not in ("2", "3", "4", "5") or row["required"] not in ("yes", "no"):
            raise ValueError(f"Invalid phase or requirement for {flow_id}")
        flows[flow_id] = row

    source = subprocess.check_output(
        ["git", "show", f"{BASELINE}:web/src/main.js"], cwd=ROOT, encoding="utf-8"
    )
    frozen_routes = re.findall(r"^\s*\{ re: (.*?), page:", source, re.MULTILINE)
    routes = read_table("web-routes.tsv", "route flow_or_exclusion")
    if frozen_routes != [row["route"] for row in routes]:
        raise ValueError("Route audit differs from the frozen Web ROUTES list")
    for row in routes:
        route, reference = row["route"], row["flow_or_exclusion"]
        if reference != ROUTE_EXCLUSIONS.get(route) and (
            route in ROUTE_EXCLUSIONS or reference not in flows
        ):
            raise ValueError(f"Unresolved route {route}: {reference}")
    return flows, len(routes)


def accepted_flows(receipt_path, flows):
    if receipt_path is None:
        return set()
    with receipt_path.open(encoding="utf-8-sig") as source:
        receipt = json.load(source)
    if receipt.get("baseline") != BASELINE or not isinstance(receipt.get("results"), dict):
        raise ValueError("Acceptance receipt has the wrong baseline or missing results")
    passed = set()
    for flow_id, result in receipt["results"].items():
        if flow_id not in flows or not isinstance(result, dict):
            raise ValueError(f"Unknown or malformed result {flow_id}")
        status = result.get("status")
        if status not in ("passed", "failed", "blocked"):
            raise ValueError(f"Invalid acceptance status for {flow_id}")
        if status != "passed":
            continue
        evidence = result.get("evidence")
        if (
            result.get("kind") != "e2e"
            or not isinstance(result.get("environment"), str)
            or not result["environment"].strip()
            or not isinstance(evidence, list)
            or not evidence
            or not all(isinstance(path, str) and path.strip() for path in evidence)
        ):
            raise ValueError(f"Missing end-to-end evidence for {flow_id}")
        for relative in evidence:
            path = (receipt_path.parent / relative).resolve()
            if not path.is_relative_to(receipt_path.parent.resolve()) or not path.is_file():
                raise ValueError(f"Invalid evidence path for {flow_id}: {relative}")
        passed.add(flow_id)
    return passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, help="Path to end-to-end acceptance results")
    parser.add_argument("--release", action="store_true", help="Require 95%% and all core flows")
    args = parser.parse_args()
    try:
        flows, route_count = inventory()
        passed = accepted_flows(args.receipt, flows)
    except (AttributeError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        parser.exit(2, f"{exc}\n")

    required = {flow_id for flow_id, row in flows.items() if row["required"] == "yes"}
    minimum = (95 * len(flows) + 99) // 100
    pending_core = required - passed
    print(f"Web baseline {BASELINE}")
    print(f"Routes audited: {route_count}")
    print(f"Flows by phase: {dict(sorted(Counter(row['stage'] for row in flows.values()).items()))}")
    print(f"Accepted: {len(passed)}/{len(flows)} ({len(passed) / len(flows):.2%})")
    print(f"Core accepted: {len(required) - len(pending_core)}/{len(required)}")
    print(f"Release minimum: {minimum}/{len(flows)}; maximum deferrals: {len(flows) - minimum}")
    if args.release and (len(passed) < minimum or pending_core):
        print(f"Unaccepted core flows: {', '.join(sorted(pending_core))}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

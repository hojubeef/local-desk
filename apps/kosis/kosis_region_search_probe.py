"""Compare KOSIS integrated search with e-local-indicator regional lists.

This script does not depend on PublicDataReader. It calls the KOSIS OpenAPI
directly with urllib so it can be used as a quick probe before wiring the
logic into the Tkinter app.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_CONFIG = Path(__file__).resolve().with_name("config.py")
KOSIS_BASE = "https://kosis.kr/openapi"


def load_api_key(config_path: Path) -> str:
    text = config_path.read_text(encoding="utf-8")
    match = re.search(r"KOSIS_API_KEY\s*=\s*(.+)", text)
    if not match:
        raise ValueError(f"KOSIS_API_KEY not found in {config_path}")
    return ast.literal_eval(match.group(1).strip())


def get_json(endpoint: str, params: dict[str, str], timeout: int = 20) -> Any:
    url = f"{KOSIS_BASE}/{endpoint}?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as response:
        body = response.read().decode("utf-8")
    return json.loads(body)


@dataclass
class KosisProbe:
    api_key: str

    def integrated_search(self, query: str, count: int) -> list[dict[str, Any]]:
        data = get_json(
            "statisticsSearch.do",
            {
                "method": "getList",
                "apiKey": self.api_key,
                "format": "json",
                "jsonVD": "Y",
                "searchNm": query,
                "resultCount": str(count),
            },
        )
        return data if isinstance(data, list) else []

    def statistics_list(self, view_code: str, parent_list_id: str = "") -> list[dict[str, Any]]:
        data = get_json(
            "statisticsList.do",
            {
                "method": "getList",
                "apiKey": self.api_key,
                "format": "json",
                "jsonVD": "Y",
                "vwCd": view_code,
                "parentListId": parent_list_id,
            },
        )
        return data if isinstance(data, list) else []

    def topic_tables(self) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for topic in self.statistics_list("MT_GTITLE01"):
            topic_id = topic.get("LIST_ID", "")
            topic_name = topic.get("LIST_NM", "")
            if not topic_id:
                continue
            for table in self.statistics_list("MT_GTITLE01", topic_id):
                if "TBL_ID" not in table:
                    continue
                enriched = dict(table)
                enriched["TOPIC_ID"] = topic_id
                enriched["TOPIC_NM"] = topic_name
                rows.append(enriched)
        return rows

    def region_tables(self, sido: str) -> list[dict[str, Any]]:
        for region in self.statistics_list("MT_GTITLE02"):
            if region.get("LIST_NM") == sido:
                return self.statistics_list("MT_GTITLE02", region.get("LIST_ID", ""))
        return []

    def table_meta_items(self, org_id: str, table_id: str) -> list[dict[str, Any]]:
        data = get_json(
            "statisticsData.do",
            {
                "method": "getMeta",
                "apiKey": self.api_key,
                "format": "json",
                "jsonVD": "Y",
                "type": "ITM",
                "orgId": org_id,
                "tblId": table_id,
            },
        )
        return data if isinstance(data, list) else []

    def has_region_item(self, table: dict[str, Any], region: str) -> tuple[bool, list[dict[str, Any]]]:
        org_id = table.get("ORG_ID", "")
        table_id = table.get("TBL_ID", "")
        if not org_id or not table_id:
            return False, []

        try:
            items = self.table_meta_items(org_id, table_id)
        except Exception:
            return False, []

        matches = [item for item in items if item.get("ITM_NM") == region]
        return bool(matches), matches


def tokenise_keyword(keyword: str) -> list[str]:
    return [token for token in re.split(r"\s+", keyword.strip()) if token]


def score_table(table_name: str, tokens: list[str]) -> int:
    score = 0
    for token in tokens:
        if token and token in table_name:
            score += 10
    if len(tokens) > 1 and "".join(tokens) in table_name:
        score += 20
    return score


def print_rows(title: str, rows: list[dict[str, Any]], limit: int) -> None:
    print(f"\n[{title}] {len(rows)}건")
    for idx, row in enumerate(rows[:limit], 1):
        org = row.get("ORG_NM") or row.get("ORG_ID", "")
        table = row.get("TBL_NM", "")
        table_id = row.get("TBL_ID", "")
        topic = row.get("TOPIC_NM", "")
        updated = row.get("SEND_DE", "")
        suffix = f" | {topic}" if topic else ""
        print(f"{idx:02d}. {table} | org={org} | tbl={table_id}{suffix} | updated={updated}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--sido", default="경상북도")
    parser.add_argument("--sigungu", default="상주시")
    parser.add_argument("--keyword", default="수도")
    parser.add_argument("--limit", type=int, default=15)
    args = parser.parse_args(argv)

    api_key = load_api_key(args.config)
    probe = KosisProbe(api_key)

    region = args.sigungu or args.sido
    integrated_query = f"{region} {args.keyword}".strip()
    tokens = tokenise_keyword(args.keyword)

    integrated = probe.integrated_search(integrated_query, args.limit)
    print_rows(f"통합검색: {integrated_query}", integrated, args.limit)

    topic_tables = probe.topic_tables()
    regional_keyword_hits = [
        table
        for table in topic_tables
        if score_table(table.get("TBL_NM", ""), tokens) > 0
    ]
    regional_keyword_hits.sort(
        key=lambda row: score_table(row.get("TBL_NM", ""), tokens),
        reverse=True,
    )
    print_rows(f"e-지방지표 주제별: '{args.keyword}' 표명 매칭", regional_keyword_hits, args.limit)

    verified: list[dict[str, Any]] = []
    for table in regional_keyword_hits[: args.limit]:
        ok, matches = probe.has_region_item(table, region)
        enriched = dict(table)
        enriched["REGION_MATCH"] = ok
        if matches:
            enriched["REGION_CODE"] = matches[0].get("ITM_ID", "")
        if ok:
            verified.append(enriched)

    print_rows(f"e-지방지표 + '{region}' 메타 확인", verified, args.limit)
    if verified:
        print("\n지역 메타 매칭 코드")
        for row in verified[: args.limit]:
            print(f"- {row['TBL_NM']}: {region}={row.get('REGION_CODE')}")

    region_tables = probe.region_tables(args.sido)
    local_region_rows = [row for row in region_tables if region in row.get("TBL_NM", "")]
    print_rows(f"e-지방지표 지역별: {args.sido} 안의 {region}", local_region_rows, args.limit)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

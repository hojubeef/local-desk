"""Report basic-data recommendation service.

The service keeps the report-data workflow separate from the KOSIS screen while
reusing the existing KosisClient search and preview primitives.
"""

from __future__ import annotations

import json
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parent
CATALOG_PATH = MODULE_DIR / "report_items.json"

SOURCE_STEPS = [
    {
        "id": "municipal_org",
        "label": "시/군 기관별 통계",
        "description": "선택한 시/군 기관별 통계에서 먼저 찾습니다.",
        "rank": 1,
    },
    {
        "id": "water_agencies",
        "label": "상하수도 주요기관",
        "description": "상수도·하수도 관련 주요기관 통계로 보강합니다.",
        "rank": 2,
    },
]

CATALOG_CACHE = None
GENERAL_ITEM_IDS = {
    "admin_area",
    "admin_population",
    "natural_conditions",
    "population",
    "future_population",
    "land_use",
    "industry",
}
LOW_SIGNAL_TERMS = {
    "보급",
    "보급률",
    "사용",
    "사용량",
    "시설",
    "현황",
    "재정",
    "원가",
    "계획",
    "운영",
    "실적",
}
DOMAIN_RELEVANCE_TERMS = {
    "water_supply": [
        "상수도", "수도", "급수", "정수", "취수", "배수", "유수", "누수", "무수",
        "상수도관", "송수", "수질", "상수원",
    ],
    "sewer": [
        "하수", "하수도", "오수", "우수", "폐수", "분뇨", "방류", "하수관",
        "하수처리", "처리장",
    ],
    "water_demand": [
        "상수도", "수도", "급수", "물수요", "절수", "유수", "누수", "무수",
        "중수도", "빗물", "재이용", "하수처리수", "폐수처리수",
    ],
    "water_reuse": [
        "재이용", "물재이용", "중수도", "빗물", "하수", "하수처리수", "폐수",
        "폐수처리수", "상수도", "급수",
    ],
}


class ReportDataError(ValueError):
    """Raised when the report-data request cannot be handled."""


def safe_text(value, fallback=""):
    if value is None:
        return fallback
    text = str(value)
    return text if text != "nan" else fallback


def parse_optional_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def load_catalog():
    global CATALOG_CACHE
    if CATALOG_CACHE is None:
        with CATALOG_PATH.open("r", encoding="utf-8") as file:
            CATALOG_CACHE = json.load(file)
    return CATALOG_CACHE


def catalog_summary(catalog=None):
    catalog = catalog or load_catalog()
    reports = []
    for report in catalog.get("reports", []):
        reports.append({
            "id": report.get("id", ""),
            "name": report.get("name", ""),
            "shortName": report.get("shortName", ""),
            "domain": report.get("domain", ""),
            "basisNote": report.get("basisNote", ""),
            "itemCount": len(report.get("items", [])),
            "items": report.get("items", []),
        })
    return {
        "version": catalog.get("version", ""),
        "note": catalog.get("note", ""),
        "sources": SOURCE_STEPS,
        "reports": reports,
    }


def get_report(catalog, report_id):
    for report in catalog.get("reports", []):
        if report.get("id") == report_id:
            return report
    raise ReportDataError("보고서 종류를 찾을 수 없습니다.")


def get_item(report, item_id):
    for item in report.get("items", []):
        if item.get("id") == item_id:
            return item
    raise ReportDataError("기초자료 항목을 찾을 수 없습니다.")


def unique_values(values):
    result = []
    seen = set()
    for value in values:
        text = safe_text(value).strip()
        if not text or text in seen:
            continue
        result.append(text)
        seen.add(text)
    return result


def item_search_terms(report, item, limit=4):
    terms = [item.get("searchKeyword"), item.get("name")]
    terms.extend(item.get("keywords", []))

    domain = report.get("domain", "")
    if domain == "water_supply":
        terms.append("상수도")
    elif domain == "sewer":
        terms.append("하수도")
    elif domain == "water_demand":
        terms.extend(["상수도", "물수요관리"])
    elif domain == "water_reuse":
        terms.extend(["물재이용", "재이용"])

    return unique_values(terms)[:limit]


def candidate_key(table_info):
    return safe_text(table_info.get("기관ID")), safe_text(table_info.get("통계표ID"))


def source_by_id(source_id):
    for source in SOURCE_STEPS:
        if source["id"] == source_id:
            return source
    return {"id": source_id, "label": source_id, "description": "", "rank": 99}


def primitive_table_copy(table_info):
    copied = {}
    for key, value in table_info.items():
        if key == "분류항목_df":
            continue
        copied[key] = value
    return copied


def term_hit_score(title, terms):
    title = safe_text(title)
    score = 0
    for term in terms:
        if not term:
            continue
        if title == term:
            score += 24
        elif title.startswith(term):
            score += 18
        elif term in title:
            score += 12
    return min(score, 30)


def relevance_text(table_info):
    parts = [
        table_info.get("통계표명", ""),
        table_info.get("기관명", ""),
        table_info.get("검색소스", ""),
    ]
    parts.extend(table_info.get("매칭경로", []) or [])
    return " ".join(safe_text(part) for part in parts)


def meaningful_terms(terms):
    values = []
    for term in terms:
        term = safe_text(term).strip()
        if len(term) < 2 or term in LOW_SIGNAL_TERMS:
            continue
        values.append(term)
    return values


def candidate_is_relevant(report, item, table_info, terms):
    if item.get("id") in GENERAL_ITEM_IDS:
        return True

    text = relevance_text(table_info)
    if any(term in text for term in meaningful_terms(terms)):
        return True

    domain_terms = DOMAIN_RELEVANCE_TERMS.get(report.get("domain", ""), [])
    return any(term in text for term in domain_terms)


def report_candidate_score(table_info, source_id, terms):
    source_base = 58 if source_id == "municipal_org" else 48
    original_score = table_info.get("추천점수")
    if original_score is None:
        original_score = table_info.get("기관별점수", 0)
    try:
        original_score = int(original_score or 0)
    except (TypeError, ValueError):
        original_score = 0

    score = source_base + min(original_score, 22) + term_hit_score(table_info.get("통계표명", ""), terms)
    return max(0, min(100, score))


def report_grade(score):
    if score >= 85:
        return "높음"
    if score >= 65:
        return "검토"
    return "낮음"


def add_candidate(candidates, seen, table_info, source_id, matched_keyword, terms, report, item):
    key = candidate_key(table_info)
    if not key[0] or not key[1] or key in seen:
        return
    if not candidate_is_relevant(report, item, table_info, terms):
        return

    source = source_by_id(source_id)
    candidate = primitive_table_copy(table_info)
    score = report_candidate_score(candidate, source_id, terms)
    candidate.update({
        "보고서항목ID": item.get("id", ""),
        "보고서항목명": item.get("name", ""),
        "추천자료출처": source_id,
        "추천자료출처명": source["label"],
        "추천자료출처설명": source["description"],
        "추천자료출처순위": source["rank"],
        "보고서추천점수": score,
        "보고서추천도": report_grade(score),
        "보고서추천사유": f"{source['label']}에서 '{matched_keyword}'로 찾은 후보",
        "매칭검색어": matched_keyword,
    })
    candidates.append(candidate)
    seen.add(key)


def flatten_folders(folders):
    if not folders:
        return []
    tables = []
    for folder_tables in folders.values():
        tables.extend(folder_tables)
    return tables


def recommend_item(client, catalog, body, max_candidates_default=5, callback=None):
    report_id = safe_text(body.get("reportId")).strip()
    item_id = safe_text(body.get("itemId")).strip()
    sido = safe_text(body.get("sido")).strip()
    sigungu = safe_text(body.get("sigungu"), "전체").strip() or "전체"
    report_year = parse_optional_int(body.get("reportYear"))
    year_window = parse_optional_int(body.get("yearWindow")) or 5
    max_candidates = parse_optional_int(body.get("maxCandidates")) or max_candidates_default
    max_candidates = max(1, min(10, max_candidates))

    if not report_id or not item_id:
        raise ReportDataError("보고서와 기초자료 항목이 필요합니다.")
    if not sido:
        raise ReportDataError("시/도를 선택해주세요.")
    if report_year is not None and not 1900 <= report_year <= 2100:
        raise ReportDataError("기준연도는 1900~2100 사이로 입력해주세요.")

    report = get_report(catalog, report_id)
    item = get_item(report, item_id)
    region_name = sigungu if sigungu and sigungu != "전체" else sido
    parent_org_name = sido if sigungu and sigungu != "전체" else None
    terms = item_search_terms(report, item)
    candidates = []
    seen = set()

    if callback:
        callback(5, f"{item.get('name', '')} 후보 검색 준비")

    if region_name and region_name != "전국":
        for idx, term in enumerate(terms[:3]):
            if callback:
                callback(8 + idx * 10, f"[시/군 기관별] {term} 검색 중")
            try:
                tables = client.search_org_tables(
                    region_name,
                    term,
                    max_results=max_candidates * 2,
                    parent_name=parent_org_name,
                )
            except Exception:
                tables = []
            for table in tables:
                client.enrich_recommendation(table, term, region_name=region_name)
                add_candidate(candidates, seen, table, "municipal_org", term, terms, report, item)
                if len(candidates) >= max_candidates:
                    break
            if len(candidates) >= max_candidates:
                break

    if len(candidates) < max_candidates:
        primary_term = terms[0] if terms else item.get("name", "")
        if callback:
            callback(55, f"[상하수도 주요기관] {primary_term} 검색 중")
        try:
            folders = client.search_and_classify(
                sido=sido,
                sigungu=sigungu,
                keyword=primary_term,
                max_results=max(6, max_candidates * 2),
                include_subregion_search=False,
                search_scope="water_agencies",
            )
        except Exception:
            folders = None
        for table in flatten_folders(folders):
            add_candidate(candidates, seen, table, "water_agencies", primary_term, terms, report, item)
            if len(candidates) >= max_candidates:
                break

    candidates.sort(
        key=lambda candidate: (
            int(candidate.get("추천자료출처순위", 99)),
            -int(candidate.get("보고서추천점수", 0)),
            safe_text(candidate.get("통계표명")),
        )
    )

    if callback:
        callback(100, f"후보 {len(candidates[:max_candidates])}건")

    return {
        "ok": True,
        "status": "ready" if candidates else "manual",
        "message": "후보를 검토하세요." if candidates else "좁힌 검색 범위에서 후보를 찾지 못했습니다. 수동 검색이 필요합니다.",
        "report": {
            "id": report.get("id", ""),
            "name": report.get("name", ""),
            "shortName": report.get("shortName", ""),
            "domain": report.get("domain", ""),
        },
        "item": item,
        "criteria": {
            "sido": sido,
            "sigungu": sigungu,
            "regionName": region_name,
            "reportYear": report_year,
            "yearWindow": max(1, min(100, year_window)),
            "searchTerms": terms,
        },
        "searchPlan": SOURCE_STEPS,
        "candidates": candidates[:max_candidates],
    }

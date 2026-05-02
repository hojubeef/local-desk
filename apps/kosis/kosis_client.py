# ============================================================
# kosis_client.py - KOSIS API 호출 모듈 (v2)
# ============================================================
#
# [v2 변경사항]
# - 검색 결과를 행정구역별(전국/시도/시군구)로 자동 분류
# - 매칭 경로 분석 (통계표명/분류항목/키워드 중 어디서 매칭됐는지)
# - 기관 수준 구분 (전국 기관 vs 지역 기관)
# - 중복 폴더 지원 (여러 행정구역에 걸친 통계표)
# ============================================================

from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import deque
from datetime import datetime
import json
import pandas as pd
import re
import threading
import time
import urllib.parse
import urllib.request

try:
    from PublicDataReader import Kosis
except ImportError:
    Kosis = None


# ============================================================
# 중앙부처 목록 (전국 단위 기관 판별용)
# ============================================================
# [왜 이 목록이 필요한가?]
# 기관명에 "환경부", "통계청" 같은 중앙부처가 나오면 "(전국)"으로,
# "상주시", "경상북도" 같은 지자체가 나오면 "(지역)"으로 구분하기 위해.
# 완벽하진 않지만 대부분 커버됨.
# ============================================================
CENTRAL_AGENCIES = [
    "통계청", "환경부", "기후에너지환경부", "국토교통부", "행정안전부", "보건복지부",
    "고용노동부", "교육부", "농림축산식품부", "산업통상자원부",
    "과학기술정보통신부", "문화체육관광부", "국방부", "법무부",
    "여성가족부", "해양수산부", "중소벤처기업부", "기획재정부",
    "외교부", "소방청", "경찰청", "국세청", "관세청", "조달청",
    "병무청", "방위사업청", "기상청", "산림청", "특허청",
    "한국은행", "한국부동산원", "한국전력공사", "한국토지주택공사",
    "한국수자원공사", "한국감정원", "금융위원회", "금융감독원",
    "국민건강보험공단", "건강보험심사평가원", "국민연금공단",
    "한국고용정보원", "한국교육개발원", "한국관광공사",
    "대법원", "중앙선거관리위원회", "국가데이터처",
]

KOSIS_OPENAPI_BASE = "https://kosis.kr/openapi"
LOCAL_TOPIC_VIEW = "MT_GTITLE01"   # e-지방지표(주제별)
LOCAL_REGION_VIEW = "MT_GTITLE02"  # e-지방지표(지역별)
SEARCH_MAX_WORKERS = 3
SEARCH_RESULT_COUNT_PER_TERM = 20
SEARCH_PRECISION_EVALUATION_LIMIT = 24
KOSIS_RATE_LIMIT_PER_MINUTE = 1000
SUBREGION_SEARCH_MAX_NAMES = 30
SUBREGION_SEARCH_RESULT_COUNT = 8

SUBREGION_SOURCE_TABLES = [
    ("101", "DT_1B04005N"),
    ("101", "DT_1IN1502"),
    ("101", "DT_1IN1503"),
    ("101", "DT_1B8000K"),
]

ORG_NAME_BY_ID = {
    "101": "국가데이터처",
}

# e-지방지표는 표명이 정제되어 있어 통합검색보다 잘 잡히는 대신,
# 사용자가 입력하는 현장 표현과 완전히 같지는 않을 수 있다.
LOCAL_KEYWORD_ALIASES = {
    "급수": ["상수도", "수도", "보급률"],
    "급수량": ["상수도", "수도", "보급률"],
    "수도": ["상수도", "하수도", "수도"],
    "인구수": ["인구", "주민등록인구", "인구총조사"],
}

SEARCH_KEYWORD_EXPANSIONS = {
    "장래인구": [
        "장래인구추계", "시군구 장래인구", "시군구 장래인구추계",
        "추계인구", "추계인구 시군구",
    ],
    "장래 인구": [
        "장래인구추계", "시군구 장래인구", "시군구 장래인구추계",
        "추계인구", "추계인구 시군구",
    ],
    "추계인구": ["장래인구추계", "시군구 장래인구", "시군구 추계인구"],
    "인구": [
        "주민등록인구", "읍면동 인구", "5세별 주민등록인구", "연령별 인구",
        "성별 인구", "인구이동", "전입인구", "전출인구", "고령인구",
        "생활인구", "인구총조사",
    ],
    "주민": ["주민등록인구", "외국인 주민", "인구"],
    "이동": ["인구이동", "전입인구", "전출인구", "순이동인구"],
    "상수도": ["상수도보급률", "시군구 상수도보급률", "급수량", "상수도 급수 보급률"],
    "수도": ["상수도", "하수도", "상수도보급률", "급수량"],
    "급수": ["상수도", "상수도보급률", "급수량"],
    "주택": ["주택수", "주택소유", "빈집", "미분양주택", "주택가격"],
}

MAJOR_REGION_HINTS = [
    "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시", "대전광역시",
    "울산광역시", "세종특별자치시", "경기도", "강원특별자치도", "충청북도", "충청남도",
    "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도",
]

WATER_OPERATION_TERMS = ["사업", "운영", "재무", "손익", "부채", "자본", "원가", "요금"]

PERIOD_CODE_BY_LABEL = {
    "년": "Y",
    "연": "Y",
    "Y": "Y",
    "A": "Y",
    "월": "M",
    "M": "M",
    "분기": "Q",
    "Q": "Q",
    "반기": "H",
    "H": "H",
    "일": "D",
    "D": "D",
    "부정기": "IR",
    "IR": "IR",
}


class KosisClient:
    """KOSIS API를 쉽게 사용하기 위한 클래스 (v2)."""

    def __init__(self, api_key):
        self.api_key = api_key
        self.api = Kosis(api_key) if Kosis else None
        self._statistics_list_cache = {}
        self._table_meta_cache = {}
        self._subregion_name_cache = {}
        self._api_usage_lock = threading.Lock()
        self._api_call_events = deque()
        self._api_total_calls = 0
        self._api_session_start_total = 0

    def _prune_api_call_events(self, now=None, window_seconds=60):
        now = now or time.time()
        cutoff = now - window_seconds
        while self._api_call_events and self._api_call_events[0][0] < cutoff:
            self._api_call_events.popleft()

    def _record_api_call(self, endpoint, method=""):
        now = time.time()
        with self._api_usage_lock:
            self._api_call_events.append((now, endpoint, method))
            self._api_total_calls += 1
            self._prune_api_call_events(now)

    def begin_api_usage_session(self):
        """이번 검색/작업의 API 호출 수 기준점을 현재 누적값으로 맞춥니다."""
        with self._api_usage_lock:
            self._api_session_start_total = self._api_total_calls

    def get_api_usage_snapshot(self, window_seconds=60):
        """최근 window_seconds 동안의 API 사용량과 누적 사용량을 반환합니다."""
        with self._api_usage_lock:
            self._prune_api_call_events(window_seconds=window_seconds)
            recent_calls = len(self._api_call_events)
            session_calls = max(0, self._api_total_calls - self._api_session_start_total)
            usage_percent = recent_calls / KOSIS_RATE_LIMIT_PER_MINUTE * 100
            return {
                "recent_calls": recent_calls,
                "session_calls": session_calls,
                "total_calls": self._api_total_calls,
                "rate_limit_per_minute": KOSIS_RATE_LIMIT_PER_MINUTE,
                "usage_percent": min(100, usage_percent),
            }

    # ----------------------------------------------------------
    # KOSIS 원 OpenAPI 호출
    # ----------------------------------------------------------
    def _openapi_json(self, endpoint, params, timeout=20):
        """PublicDataReader가 감싸지 않는 API를 직접 호출합니다."""
        query = {
            "apiKey": self.api_key,
            "format": "json",
            "jsonVD": "Y",
        }
        query.update(params)

        url = f"{KOSIS_OPENAPI_BASE}/{endpoint}?" + urllib.parse.urlencode(query)
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                body = response.read().decode("utf-8")
        finally:
            self._record_api_call(endpoint, params.get("method", ""))

        data = json.loads(body)
        if isinstance(data, dict) and data.get("err"):
            return []
        return data

    def get_statistics_list(self, view_code, parent_list_id=""):
        """
        통계목록 API를 조회합니다.

        view_code 예:
        - MT_GTITLE01: e-지방지표(주제별)
        - MT_GTITLE02: e-지방지표(지역별)
        """
        cache_key = (view_code, parent_list_id)
        if cache_key in self._statistics_list_cache:
            return self._statistics_list_cache[cache_key]

        try:
            data = self._openapi_json(
                "statisticsList.do",
                {
                    "method": "getList",
                    "vwCd": view_code,
                    "parentListId": parent_list_id,
                },
            )
            rows = data if isinstance(data, list) else []
        except Exception as e:
            print(f"통계목록 조회 오류: {e}")
            rows = []

        self._statistics_list_cache[cache_key] = rows
        return rows

    def get_table_meta(self, org_id, tbl_id, meta_type):
        """statisticsData.do?method=getMeta 메타정보를 DataFrame으로 가져옵니다."""
        cache_key = (org_id, tbl_id, meta_type)
        if cache_key in self._table_meta_cache:
            return self._table_meta_cache[cache_key]

        try:
            data = self._openapi_json(
                "statisticsData.do",
                {
                    "method": "getMeta",
                    "type": meta_type,
                    "orgId": org_id,
                    "tblId": tbl_id,
                },
            )
            df = pd.DataFrame(data) if isinstance(data, list) and data else None
        except Exception as e:
            print(f"통계표 메타 조회 오류: {e}")
            df = None

        self._table_meta_cache[cache_key] = df
        return df

    def get_table_meta_items(self, org_id, tbl_id):
        """getMeta(type=ITM) 결과를 기존 GUI가 읽는 분류항목 형태로 정규화합니다."""
        df = self.get_table_meta(org_id, tbl_id, "ITM")
        if df is None or len(df) == 0:
            return None

        rows = []
        for _, row in df.iterrows():
            rows.append({
                "분류ID": row.get("OBJ_ID", ""),
                "분류명": row.get("OBJ_NM", ""),
                "분류값ID": row.get("ITM_ID", ""),
                "분류값명": row.get("ITM_NM", ""),
                "상위분류값ID": row.get("UP_ITM_ID", ""),
                "통계표ID": row.get("TBL_ID", tbl_id),
                "기관ID": row.get("ORG_ID", org_id),
            })

        return pd.DataFrame(rows)

    def get_table_period_from_meta(self, org_id, tbl_id):
        """getMeta(type=PRD)로 수록기간을 조회합니다."""
        df = self.get_table_meta(org_id, tbl_id, "PRD")
        if df is None or len(df) == 0:
            return "?", "?", "?"

        row = df.iloc[0]
        cycle = row.get("PRD_SE", "?")
        start = row.get("STRT_PRD_DE", "?")
        end = row.get("END_PRD_DE", "?")
        return cycle, start, end

    # ----------------------------------------------------------
    # 선택 데이터 조회
    # ----------------------------------------------------------
    def get_data_selection_options(self, org_id, tbl_id, region_name=None):
        """
        통계자료 조회에 필요한 항목/분류/주기 선택지를 정리합니다.

        KOSIS 원 메타에서는 항목과 분류값이 type=ITM에 함께 들어오므로,
        앱에서 쓰기 쉽게 항목 목록과 objL1~objL8 분류 그룹으로 나눕니다.
        """
        item_df = self.get_table_meta(org_id, tbl_id, "ITM")
        cycle, start_prd, end_prd = self.get_table_period_from_meta(org_id, tbl_id)

        options = {
            "items": [],
            "objects": [],
            "period": {
                "label": cycle,
                "code": PERIOD_CODE_BY_LABEL.get(str(cycle), "Y"),
                "start": start_prd,
                "end": end_prd,
            },
            "region_match": None,
        }

        if item_df is None or len(item_df) == 0:
            options["items"].append({"id": "ALL", "name": "전체"})
            return options

        groups = {}
        fallback_order = 1

        for _, row in item_df.iterrows():
            obj_id = str(row.get("OBJ_ID", "") or "")
            obj_nm = str(row.get("OBJ_NM", "") or "")
            value_id = str(row.get("ITM_ID", "") or "")
            value_nm = str(row.get("ITM_NM", "") or "")
            up_value_id = str(row.get("UP_ITM_ID", "") or "")

            if not value_id:
                continue

            if obj_id == "ITEM" or obj_nm == "항목":
                options["items"].append({
                    "id": value_id,
                    "name": value_nm,
                    "obj_id": obj_id,
                    "obj_name": obj_nm,
                })
                continue

            obj_sn = row.get("OBJ_ID_SN", "")
            try:
                level = int(obj_sn)
            except (TypeError, ValueError):
                level = fallback_order
                fallback_order += 1

            if obj_id not in groups:
                groups[obj_id] = {
                    "obj_id": obj_id,
                    "obj_name": obj_nm,
                    "level": level,
                    "values": [],
                    "selected": None,
                }

            value = {
                "id": value_id,
                "name": value_nm,
                "up_id": up_value_id,
            }
            groups[obj_id]["values"].append(value)

            if region_name and value_nm == region_name:
                groups[obj_id]["selected"] = value
                options["region_match"] = {
                    "obj_id": obj_id,
                    "obj_name": obj_nm,
                    "level": level,
                    "id": value_id,
                    "name": value_nm,
                }

        if not options["items"]:
            options["items"].append({"id": "ALL", "name": "전체"})

        options["objects"] = sorted(groups.values(), key=lambda group: group["level"])
        return options

    def summarize_selection_options(self, options):
        """
        항목/분류 메타를 보고 보고서용으로 쓸 수 있는 세분화 수준을 요약합니다.

        예: 행정구역 분류가 읍면동까지 내려가는지, 선택 지역 아래에
        하위값이 몇 개 있는지, 연령/성별 같은 추가 분류가 있는지.
        """
        summaries = []

        items = options.get("items", [])
        if items:
            sample = ", ".join(item.get("name", "") for item in items[:4])
            if len(items) > 4:
                sample += f" 외 {len(items) - 4}개"
            summaries.append(f"항목: {len(items)}개 ({sample})")

        for group in options.get("objects", []):
            values = group.get("values", [])
            obj_name = group.get("obj_name", group.get("obj_id", "분류"))
            if not values:
                summaries.append(f"{obj_name}: 값 없음")
                continue

            tree = self._build_value_tree(values)
            max_depth = self._max_value_depth(tree)
            granularity = self._infer_granularity(obj_name, values)
            leaf_count = sum(1 for value in values if not tree["children"].get(value.get("id", "")))

            selected = group.get("selected")
            selected_text = ""
            if selected:
                selected_id = selected.get("id", "")
                children = tree["children"].get(selected_id, [])
                descendants = self._descendant_values(tree, selected_id)
                if children:
                    names = ", ".join(child.get("name", "") for child in children[:5])
                    if len(children) > 5:
                        names += f" 외 {len(children) - 5}개"
                    selected_text = (
                        f" | {selected.get('name')} 하위 {len(children)}개"
                        f"(전체 하위 {len(descendants)}개): {names}"
                    )
                else:
                    selected_text = f" | {selected.get('name')} 하위값 없음"

            summaries.append(
                f"{obj_name}: {len(values)}개 값, 최대 {max_depth}단계, "
                f"{granularity}, 최하위 {leaf_count}개{selected_text}"
            )

        return summaries

    def _build_value_tree(self, values):
        value_by_id = {value.get("id", ""): value for value in values}
        children = {}
        roots = []

        for value in values:
            value_id = value.get("id", "")
            up_id = value.get("up_id", "")
            if up_id and up_id in value_by_id:
                children.setdefault(up_id, []).append(value)
            else:
                roots.append(value)

        return {
            "value_by_id": value_by_id,
            "children": children,
            "roots": roots,
        }

    def _max_value_depth(self, tree):
        def depth(value):
            children = tree["children"].get(value.get("id", ""), [])
            if not children:
                return 1
            return 1 + max(depth(child) for child in children)

        roots = tree.get("roots", [])
        if not roots:
            return 0
        return max(depth(root) for root in roots)

    def _descendant_values(self, tree, value_id):
        descendants = []
        for child in tree["children"].get(value_id, []):
            descendants.append(child)
            descendants.extend(self._descendant_values(tree, child.get("id", "")))
        return descendants

    def _infer_granularity(self, obj_name, values):
        names = [str(value.get("name", "")) for value in values]
        if "행정구역" in obj_name:
            if any(name.endswith(("읍", "면", "동")) or "출장소" in name for name in names):
                return "읍면동까지"
            if any(name.endswith(("시", "군", "구")) for name in names):
                return "시군구까지"
            if any(("특별시" in name or "광역시" in name or name.endswith("도")) for name in names):
                return "시도까지"
            return "행정구역 분류"

        if any("세" in name for name in names):
            return "연령 구간"
        if any(name in ("남자", "여자", "남", "여") for name in names):
            return "성별"
        return "일반 분류"

    def fetch_selected_data(
        self,
        org_id,
        tbl_id,
        region_name=None,
        item_id=None,
        latest_count=5,
        start_period=None,
        end_period=None,
        obj_selections=None,
    ):
        """
        선택한 항목/분류/기간만 통계자료 API에서 조회합니다.

        obj_selections는 {"SGG": "37080"} 또는 {"SGG": ["37080", "37070"]}
        처럼 분류ID별 선택값을 넘길 때 사용합니다.
        지정하지 않으면 선택 지역이 들어있는 분류는 해당 지역으로, 나머지는 ALL로 조회합니다.
        """
        options = self.get_data_selection_options(org_id, tbl_id, region_name)
        items = options.get("items", [])
        selected_item_id = self._format_selection_value(item_id or (items[0]["id"] if items else "ALL"))

        params = {
            "method": "getList",
            "orgId": org_id,
            "tblId": tbl_id,
            "itmId": selected_item_id,
            "prdSe": options["period"]["code"],
            "prdInterval": "1",
        }

        if start_period and end_period:
            params["startPrdDe"] = str(start_period)
            params["endPrdDe"] = str(end_period)
        else:
            params["newEstPrdCnt"] = str(max(1, int(latest_count or 1)))

        objects = options.get("objects", [])
        obj_selections = obj_selections or {}
        used_levels = set()

        for group in objects:
            level = group.get("level")
            if not level or level < 1 or level > 8:
                continue

            selection = obj_selections.get(group["obj_id"])
            if selection is None and group.get("selected"):
                selection = group["selected"]["id"]
            if selection is None:
                selection = "ALL"

            params[f"objL{level}"] = self._format_selection_value(selection)
            used_levels.add(level)

        if not used_levels:
            params["objL1"] = "ALL"
            used_levels.add(1)

        for level in range(1, 9):
            params.setdefault(f"objL{level}", "")

        try:
            data = self._openapi_json("Param/statisticsParameterData.do", params)
            if not isinstance(data, list) or not data:
                return None
            return pd.DataFrame(data)
        except Exception as e:
            print(f"통계자료 조회 오류: {e}")
            return None

    def _format_selection_value(self, value):
        """KOSIS 다중 선택 파라미터 형식(코드+코드)으로 변환합니다."""
        if value is None:
            return "ALL"
        if isinstance(value, (list, tuple, set)):
            values = [str(v) for v in value if v]
            if not values:
                return "ALL"
            if "ALL" in values:
                return "ALL"
            return "+".join(values)
        return str(value)

    # ----------------------------------------------------------
    # 기본 검색
    # ----------------------------------------------------------
    def search(self, keyword, max_results=30):
        """키워드로 KOSIS 통계표를 검색합니다."""
        try:
            data = self._openapi_json(
                "statisticsSearch.do",
                {
                    "method": "getList",
                    "searchNm": keyword,
                    "resultCount": str(max_results),
                },
            )
            rows = []
            for row in data if isinstance(data, list) else []:
                start_prd = row.get("STRT_PRD_DE", "")
                end_prd = row.get("END_PRD_DE", "")
                period = f"{start_prd} ~ {end_prd}" if (start_prd or end_prd) else ""
                rows.append({
                    "통계표명": row.get("TBL_NM", ""),
                    "기관명": row.get("ORG_NM", ""),
                    "기관ID": row.get("ORG_ID", ""),
                    "통계표ID": row.get("TBL_ID", ""),
                    "통계표주요내용": row.get("CONTENTS", ""),
                    "수록기간": period,
                    "수록주기": row.get("PRD_SE", ""),
                    "수록기간시작일": start_prd,
                    "수록기간종료일": end_prd,
                    "검색어": keyword,
                })
            if not rows:
                return None
            return pd.DataFrame(rows)
        except Exception as e:
            print(f"검색 오류: {e}")
            return None

    # ----------------------------------------------------------
    # 분류항목 조회
    # ----------------------------------------------------------
    def get_categories(self, org_id, tbl_id):
        """특정 통계표의 분류항목을 조회합니다."""
        try:
            df = self.get_table_meta_items(org_id, tbl_id)
            if df is None or len(df) == 0:
                return None
            return df
        except Exception as e:
            print(f"분류항목 조회 오류: {e}")
            return None

    # ----------------------------------------------------------
    # 수록정보 조회
    # ----------------------------------------------------------
    def get_period_info(self, org_id, tbl_id):
        """특정 통계표의 수록기간/주기를 조회합니다."""
        try:
            raw_df = self.get_table_meta(org_id, tbl_id, "PRD")
            if raw_df is None or len(raw_df) == 0:
                return None

            rows = []
            for _, row in raw_df.iterrows():
                rows.append({
                    "수록주기": row.get("PRD_SE", ""),
                    "수록기간시작일": row.get("STRT_PRD_DE", ""),
                    "수록기간종료일": row.get("END_PRD_DE", ""),
                })
            return pd.DataFrame(rows)
        except Exception as e:
            print(f"수록정보 조회 오류: {e}")
            return None

    # ----------------------------------------------------------
    # 기관 수준 판별
    # ----------------------------------------------------------
    def classify_agency(self, org_name):
        """
        기관명을 보고 전국/지역 기관인지 판별합니다.

        [왜 이런 방식인가?]
        KOSIS API에는 기관이 전국/지역인지 구분해주는 필드가 없음.
        그래서 기관명을 보고 추정하는 방식을 사용.
        중앙부처 목록에 있으면 "전국", 없으면 "지역"으로 분류.
        """
        for agency in CENTRAL_AGENCIES:
            if agency in org_name:
                return "전국"
        return "지역"

    # ----------------------------------------------------------
    # 매칭 경로 분석
    # ----------------------------------------------------------
    def analyze_match_type(self, keyword, tbl_name, tbl_content, cat_df):
        """
        통계표가 검색에 걸린 이유를 분석합니다.

        [반환값]
        리스트: ["통계표명", "분류항목", "키워드"] 중 해당하는 것들

        [동작 방식]
        1. 통계표명에 검색어가 포함되어 있는지 확인
        2. 분류항목(분류값명)에 검색어가 포함되어 있는지 확인
        3. 위 둘 다 아니면 KOSIS 내부 키워드 매칭으로 판단
        """
        match_types = []

        # 검색 키워드를 공백으로 분리 (예: "상주시 수도" → ["상주시", "수도"])
        keywords = keyword.strip().split()

        # 1. 통계표명 매칭 확인
        if tbl_name:
            for kw in keywords:
                if kw in str(tbl_name):
                    match_types.append("통계표명")
                    break

        # 2. 분류항목 매칭 확인
        if cat_df is not None and '분류값명' in cat_df.columns:
            for kw in keywords:
                if cat_df['분류값명'].str.contains(kw, na=False).any():
                    if "분류항목" not in match_types:
                        match_types.append("분류항목")
                    break

        # 3. 위 둘 다 아니면 키워드 매칭
        if not match_types:
            # 통계표 주요내용에서도 확인
            if tbl_content:
                for kw in keywords:
                    if kw in str(tbl_content):
                        match_types.append("주요내용")
                        break

            if not match_types:
                match_types.append("키워드")

        return match_types

    # ----------------------------------------------------------
    # 행정구역 분류
    # ----------------------------------------------------------
    def classify_region_level(self, cat_df, sido, sigungu):
        """
        통계표의 분류항목을 보고, 어떤 행정구역 수준의 데이터가 있는지 판별.

        [반환값]
        리스트: ["전국", "경상북도", "상주시"] 등 해당하는 행정구역들

        [동작 방식]
        분류값명에서 "전국", 시도명, 시군구명을 각각 검색.
        포함되어 있으면 해당 수준의 데이터가 있다고 판단.
        """
        levels = []

        if cat_df is None or '분류값명' not in cat_df.columns:
            # 분류항목을 못 가져왔으면 판별 불가 → "미분류"
            return ["미분류"]

        all_values = cat_df['분류값명'].str.cat(sep=' ')

        # 전국 확인
        if "전국" in all_values or "합계" in all_values:
            levels.append("전국")

        # 시도 확인
        if sido and sido != "전국":
            # "경상북도" 또는 "경북" 같은 약칭도 확인
            sido_short = sido.replace("특별시", "").replace("광역시", "").replace("특별자치시", "").replace("특별자치도", "").replace("도", "")
            if sido in all_values or sido_short in all_values:
                levels.append(sido)

        # 시군구 확인
        if sigungu and sigungu != "전체":
            if sigungu in all_values:
                levels.append(sigungu)

        # 아무것도 안 잡히면
        if not levels:
            levels.append("미분류")

        return levels

    def get_subregion_names(self, sido, sigungu):
        """선택 시군구의 하위 읍면동명을 한 번만 조회해서 캐시합니다."""
        if not sigungu or sigungu == "전체":
            return []

        cache_key = (sido or "", sigungu)
        if cache_key in self._subregion_name_cache:
            return self._subregion_name_cache[cache_key]

        for org_id, tbl_id in SUBREGION_SOURCE_TABLES:
            try:
                options = self.get_data_selection_options(org_id, tbl_id, region_name=sigungu)
            except Exception:
                continue

            for group in options.get("objects", []):
                selected = group.get("selected")
                if not selected:
                    continue

                selected_id = str(selected.get("id", ""))
                children = [
                    value
                    for value in group.get("values", [])
                    if str(value.get("up_id", "")) == selected_id
                ]
                names = []
                for child in children:
                    name = str(child.get("name", "") or "").strip()
                    if name and name not in names:
                        names.append(name)

                if names:
                    self._subregion_name_cache[cache_key] = names
                    return names

        self._subregion_name_cache[cache_key] = []
        return []

    def build_subregion_search_terms(self, sido, sigungu, keyword, max_names=SUBREGION_SEARCH_MAX_NAMES):
        """읍면동 분류값 검색 보강용 검색어를 만듭니다."""
        names = self.get_subregion_names(sido, sigungu)
        keyword = str(keyword or "").strip()
        terms = []

        for name in names[:max_names]:
            if keyword and keyword in name:
                term = f"{sigungu} {name}"
            else:
                term = f"{sigungu} {name} {keyword}".strip()
            if term not in terms:
                terms.append(term)

        return terms

    # ----------------------------------------------------------
    # 검색어 확장 및 추천도 평가
    # ----------------------------------------------------------
    def build_search_terms(self, sido, sigungu, keyword, max_terms=14):
        """
        사용자는 단순히 '상주시 + 인구'처럼 검색하고,
        내부적으로는 보고서에 자주 쓰는 세부 후보어를 함께 탐색합니다.
        """
        region = sigungu if (sigungu and sigungu != "전체") else sido
        keyword = keyword.strip()
        compact_keyword = keyword.replace(" ", "")

        seeds = [keyword]
        exact_key = None
        for key in SEARCH_KEYWORD_EXPANSIONS:
            if compact_keyword == key.replace(" ", ""):
                exact_key = key
                break

        if exact_key:
            seeds.extend(SEARCH_KEYWORD_EXPANSIONS[exact_key])
        else:
            for key, expansions in SEARCH_KEYWORD_EXPANSIONS.items():
                key_compact = key.replace(" ", "")
                if key_compact in compact_keyword or compact_keyword in key_compact:
                    seeds.extend(expansions)

        unique_seeds = []
        for seed in seeds:
            if seed and seed not in unique_seeds:
                unique_seeds.append(seed)

        terms = []
        if unique_seeds:
            if region:
                terms.append(f"{region} {unique_seeds[0]}")
            terms.append(unique_seeds[0])

        for seed in unique_seeds[1:]:
            if region:
                terms.append(f"{region} {seed}")

        for seed in unique_seeds[1:5]:
            terms.append(seed)

        unique_terms = []
        for term in terms:
            if term and term not in unique_terms:
                unique_terms.append(term)

        return unique_terms[:max_terms]

    def search_many(self, search_terms, result_count=12, callback=None):
        """여러 검색어를 최대 3개씩 병렬 조회하고 중복 통계표를 제거합니다."""
        frames_by_index = {}
        total_terms = len(search_terms)

        def search_one(idx, term):
            df = self.search(term, max_results=result_count)
            if df is None or len(df) == 0:
                return idx, term, None

            df = df.copy()
            df["검색어"] = term
            return idx, term, df

        with ThreadPoolExecutor(max_workers=SEARCH_MAX_WORKERS) as executor:
            future_map = {
                executor.submit(search_one, idx, term): (idx, term)
                for idx, term in enumerate(search_terms)
            }

            completed = 0
            for future in as_completed(future_map):
                idx, term = future_map[future]
                completed += 1

                try:
                    result_idx, _, df = future.result()
                except Exception as e:
                    print(f"확장검색 오류({term}): {e}")
                    df = None
                    result_idx = idx

                if df is not None:
                    frames_by_index[result_idx] = df

                if callback:
                    progress = int(completed / max(1, total_terms) * 100)
                    callback(progress, f"[확장검색] {completed}/{total_terms}개 완료")

        if not frames_by_index:
            return None

        frames = [
            frames_by_index[idx]
            for idx in sorted(frames_by_index)
        ]
        combined = pd.concat(frames, ignore_index=True)
        if '기관ID' in combined.columns and '통계표ID' in combined.columns:
            combined = combined.drop_duplicates(
                subset=['기관ID', '통계표ID'], keep='first'
            )

        return combined.reset_index(drop=True)

    def _describe_options_for_list(self, options):
        """목록표에 표시할 지역수준/세부분류/최신시점 요약을 만듭니다."""
        region_level = "미확인"
        detail_parts = []

        items = options.get("items", [])
        if items:
            detail_parts.append(f"항목 {len(items)}개")

        for group in options.get("objects", []):
            values = group.get("values", [])
            obj_name = group.get("obj_name", group.get("obj_id", "분류"))
            granularity = self._infer_granularity(obj_name, values)

            if "행정구역" in obj_name:
                region_level = granularity
                selected = group.get("selected")
                if selected:
                    tree = self._build_value_tree(values)
                    children = tree["children"].get(selected.get("id", ""), [])
                    descendants = self._descendant_values(tree, selected.get("id", ""))
                    if children:
                        region_level = (
                            f"{granularity} ({selected.get('name')} 하위 {len(children)}개)"
                        )
                    elif descendants:
                        region_level = (
                            f"{granularity} ({selected.get('name')} 하위 {len(descendants)}개)"
                        )
            else:
                detail_parts.append(f"{obj_name} {len(values)}개")

        period = options.get("period", {})
        return {
            "지역수준요약": region_level,
            "세부분류요약": ", ".join(detail_parts[:3]) if detail_parts else "분류 없음",
            "최신시점": period.get("end", "?"),
        }

    def _recommendation_grade(self, score):
        if score >= 80:
            return "높음"
        if score >= 50:
            return "보통"
        return "낮음"

    def _extract_year(self, value):
        match = re.search(r"(19|20)\d{2}", str(value or ""))
        if not match:
            return None
        try:
            return int(match.group(0))
        except ValueError:
            return None

    def _is_future_population_query(self, keyword):
        compact = str(keyword or "").replace(" ", "")
        return "장래" in compact or "추계" in compact

    def _is_water_query(self, keyword):
        compact = str(keyword or "").replace(" ", "")
        return "상수도" in compact or compact in ("수도", "급수", "급수량")

    def _is_population_query(self, keyword):
        return "인구" in str(keyword or "")

    def _has_other_region_hint(self, text, sido=None, sigungu=None):
        text = str(text or "")
        allowed = {value for value in (sido, sigungu) if value and value != "전체"}
        for region in MAJOR_REGION_HINTS:
            if region in allowed:
                continue
            if region in text:
                return True
        return False

    def quick_candidate_score(self, row, keyword, sido=None, sigungu=None):
        """메타 호출 전 제목/검색응답만으로 정밀평가 후보를 추립니다."""
        tbl_name = str(row.get("통계표명", "") or row.get("TBL_NM", "") or "")
        source = str(row.get("검색소스", "") or "")
        end_year = self._extract_year(row.get("수록기간종료일", "") or row.get("END_PRD_DE", ""))
        score = 0

        if keyword and keyword in tbl_name:
            score += 30

        for expanded in SEARCH_KEYWORD_EXPANSIONS.get(keyword, []):
            if expanded in tbl_name:
                score += 14
                break

        if self._is_future_population_query(keyword):
            if "추계" in tbl_name:
                score += 45
            if "장래" in tbl_name:
                score += 35
            if "시군구" in tbl_name or "시/군/구" in tbl_name:
                score += 28
            if "시나리오" in tbl_name and "시군구" not in tbl_name and "시/군/구" not in tbl_name:
                score -= 8
            if "인구" in tbl_name and "추계" not in tbl_name and "장래" not in tbl_name:
                score -= 35
        elif self._is_water_query(keyword):
            if "상수도보급률" in tbl_name:
                score += 55
            elif "상수도" in tbl_name and ("보급" in tbl_name or "급수" in tbl_name):
                score += 35
            elif "상수도" in tbl_name:
                score += 18
            if any(term in tbl_name for term in WATER_OPERATION_TERMS):
                score -= 25
        elif self._is_population_query(keyword):
            population_terms = [
                ("주민등록", 25), ("읍면동", 20), ("동읍면", 20), ("5세", 14),
                ("연령", 10), ("성별", 8), ("이동", 8), ("인구총조사", 8),
            ]
            for term, weight in population_terms:
                if term in tbl_name:
                    score += weight

        if "읍면동" in tbl_name or "동읍면" in tbl_name:
            score += 22
        elif "시군구" in tbl_name or "시/군/구" in tbl_name:
            score += 20
        elif "시도" in tbl_name:
            score += 4

        if end_year:
            current_year = datetime.now().year
            if self._is_future_population_query(keyword) and end_year >= current_year + 4:
                score += 18
            elif end_year >= current_year - 3:
                score += 12
            elif end_year < 2010:
                score -= 45
            elif end_year < 2018:
                score -= 18

        if source == "e-지방지표":
            score += 8

        if self._has_other_region_hint(tbl_name, sido=sido, sigungu=sigungu):
            score -= 45

        return score

    def _apply_keyword_specific_score(self, score, reasons, tbl_name, keyword):
        if self._is_future_population_query(keyword):
            if "추계" in tbl_name:
                score += 30
                reasons.append("추계지표")
            if "장래" in tbl_name:
                score += 20
                reasons.append("장래지표")
            if "시군구" in tbl_name or "시/군/구" in tbl_name:
                score += 18
                reasons.append("시군구 지표명")
            if "인구" in tbl_name and "추계" not in tbl_name and "장래" not in tbl_name:
                score -= 30
                reasons.append("현재인구 감점")
        elif self._is_water_query(keyword):
            if "상수도보급률" in tbl_name:
                score += 35
                reasons.append("상수도보급률")
            elif "상수도" in tbl_name and ("보급" in tbl_name or "급수" in tbl_name):
                score += 18
                reasons.append("급수/보급 지표")
            elif not any(term in tbl_name for term in ("상수도", "하수도", "수도", "급수", "보급")):
                score -= 35
                reasons.append("상수도 관련도 낮음")
            if any(term in tbl_name for term in WATER_OPERATION_TERMS):
                score -= 20
                reasons.append("운영/재무성 표 감점")
        elif self._is_population_query(keyword):
            if "주민등록" in tbl_name:
                score += 18
                reasons.append("주민등록인구")
            if "읍면동" in tbl_name or "동읍면" in tbl_name:
                score += 10
                reasons.append("읍면동 표명")

        return score

    def _apply_recency_score(self, score, reasons, table_info, keyword):
        latest_year = self._extract_year(
            table_info.get("최신시점", "") or table_info.get("수록기간종료일", "")
        )
        if not latest_year:
            return score

        current_year = datetime.now().year
        if self._is_future_population_query(keyword) and latest_year >= current_year + 4:
            score += 20
            reasons.append("장래기간")
        elif latest_year >= current_year - 3:
            score += 12
            reasons.append("최신성")
        elif latest_year < 2010:
            score -= 35
            reasons.append("오래된 표 감점")
        elif latest_year < 2018:
            score -= 15
            reasons.append("낡은 표 감점")

        return score

    def enrich_recommendation(self, table_info, keyword, region_name=None):
        """통계표 메타를 보고 보고서 후보로서의 추천도를 계산합니다."""
        score = 0
        reasons = []
        tbl_name = table_info.get("통계표명", "")
        source = table_info.get("검색소스", "")
        has_region_match = False

        options = None
        try:
            options = self.get_data_selection_options(
                table_info.get("기관ID", ""),
                table_info.get("통계표ID", ""),
                region_name=region_name,
            )
        except Exception:
            options = None

        if options:
            desc = self._describe_options_for_list(options)
            table_info.update(desc)

            region_match = options.get("region_match")
            has_region_match = bool(region_match)
            if region_match:
                score += 25
                reasons.append(f"{region_match.get('name')} 포함")

            region_summary = desc.get("지역수준요약", "")
            if has_region_match and "읍면동까지" in region_summary:
                score += 35
                reasons.append("읍면동 가능")
            elif has_region_match and "시군구까지" in region_summary:
                score += 22
                reasons.append("시군구 가능")
            elif has_region_match and "시도까지" in region_summary:
                score += 8
                reasons.append("시도 가능")
            elif "읍면동까지" in region_summary or "시군구까지" in region_summary:
                score += 5
                reasons.append("지역수준 확인")

            if "연령" in desc.get("세부분류요약", "") or "5세" in desc.get("세부분류요약", ""):
                score += 8
                reasons.append("연령 분류")

        else:
            table_info.setdefault("지역수준요약", "미확인")
            table_info.setdefault("세부분류요약", "미확인")
            table_info.setdefault("최신시점", table_info.get("수록기간종료일", "?"))

        if keyword and keyword in tbl_name:
            score += 20
            reasons.append("표명 직접매칭")

        for expanded in SEARCH_KEYWORD_EXPANSIONS.get(keyword, []):
            if expanded in tbl_name:
                score += 8
                reasons.append(f"확장어({expanded})")
                break

        score = self._apply_keyword_specific_score(score, reasons, tbl_name, keyword)
        score = self._apply_recency_score(score, reasons, table_info, keyword)

        if not has_region_match and self._has_other_region_hint(tbl_name, sigungu=region_name):
            score -= 25
            reasons.append("다른 지역 전용표 감점")

        match_types = table_info.get("매칭경로", [])
        if "분류항목" in match_types:
            score += 8
        if source == "e-지방지표":
            score += 8
            reasons.append("지역지표")

        table_info["추천점수"] = score
        table_info["추천도"] = self._recommendation_grade(score)
        table_info["추천사유"] = ", ".join(reasons[:4]) if reasons else "기본 후보"
        return table_info

    # ----------------------------------------------------------
    # e-지방지표 전용 검색
    # ----------------------------------------------------------
    def _expanded_local_keywords(self, keyword):
        """지역지표 표명 검색용 키워드와 간단한 연관어를 만듭니다."""
        tokens = [t for t in keyword.strip().split() if t]
        if keyword.strip() and keyword.strip() not in tokens:
            tokens.append(keyword.strip())

        expanded = []
        for token in tokens:
            expanded.append(token)
            for key, aliases in LOCAL_KEYWORD_ALIASES.items():
                if token == key or key in token or token in key:
                    expanded.extend(aliases)

        unique = []
        for token in expanded:
            if token and token not in unique:
                unique.append(token)
        return unique

    def _score_local_indicator_table(self, tbl_name, keyword, expanded_keywords):
        """e-지방지표 후보 표명을 점수화합니다."""
        if not tbl_name:
            return 0

        score = 0
        keyword = keyword.strip()
        if keyword and keyword in tbl_name:
            score += 100

        for token in expanded_keywords:
            if token in tbl_name:
                score += 15 if token in keyword else 8

        if score > 0:
            if "시/군/구" in tbl_name:
                score += 8
            elif "시도" in tbl_name:
                score += 3

        return score

    def get_local_indicator_topic_tables(self):
        """e-지방지표(주제별)의 전체 통계표 목록을 가져옵니다."""
        cache_key = ("local_topic_tables", "")
        if cache_key in self._statistics_list_cache:
            return self._statistics_list_cache[cache_key]

        tables = []
        for topic in self.get_statistics_list(LOCAL_TOPIC_VIEW):
            topic_id = topic.get("LIST_ID", "")
            topic_name = topic.get("LIST_NM", "")
            if not topic_id:
                continue

            for table in self.get_statistics_list(LOCAL_TOPIC_VIEW, topic_id):
                if not table.get("TBL_ID"):
                    continue
                enriched = dict(table)
                enriched["주제ID"] = topic_id
                enriched["주제명"] = topic_name
                tables.append(enriched)

        self._statistics_list_cache[cache_key] = tables
        return tables

    def get_local_region_tables(self, sido):
        """e-지방지표(지역별)에서 특정 시도 하위 통계표를 가져옵니다."""
        for region in self.get_statistics_list(LOCAL_REGION_VIEW):
            if region.get("LIST_NM") == sido:
                return self.get_statistics_list(LOCAL_REGION_VIEW, region.get("LIST_ID", ""))
        return []

    def search_local_indicators(self, sido, sigungu, keyword, max_results=30, callback=None):
        """
        e-지방지표 목록에서 키워드에 맞는 지역 통계표를 찾습니다.

        통합검색과 달리 표 목록을 먼저 훑고, 통계표 메타에서 선택 지역
        (예: 상주시)이 실제 분류값으로 존재하는지 확인합니다.
        """
        region_name = sigungu if (sigungu and sigungu != "전체") else sido
        if not region_name or region_name == "전국":
            return []

        expanded_keywords = self._expanded_local_keywords(keyword)
        candidates = []

        for table in self.get_local_indicator_topic_tables():
            tbl_name = table.get("TBL_NM", "")
            score = self._score_local_indicator_table(tbl_name, keyword, expanded_keywords)
            if score <= 0:
                continue
            candidates.append((score, table))

        candidates.sort(key=lambda item: item[0], reverse=True)
        if not candidates:
            return []

        results = []
        check_count = min(len(candidates), max_results * 2)

        for idx, (score, table) in enumerate(candidates[:check_count]):
            if callback:
                progress = int((idx + 1) / check_count * 100)
                callback(progress, f"[지역지표] {table.get('TBL_NM', '')[:25]}... 확인 중")

            org_id = table.get("ORG_ID", "")
            tbl_id = table.get("TBL_ID", "")
            tbl_name = table.get("TBL_NM", "")
            if not org_id or not tbl_id:
                continue

            item_df = self.get_table_meta_items(org_id, tbl_id)
            if item_df is None or "분류값명" not in item_df.columns:
                continue

            region_matches = item_df[item_df["분류값명"] == region_name]
            if len(region_matches) == 0:
                continue

            cycle, start_prd, end_prd = self.get_table_period_from_meta(org_id, tbl_id)
            org_name = ORG_NAME_BY_ID.get(org_id, org_id)
            exact_match = keyword.strip() and keyword.strip() in tbl_name
            match_types = ["지역지표", "통계표명" if exact_match else "연관어"]

            region_code = region_matches.iloc[0].get("분류값ID", "")
            results.append({
                "통계표명": tbl_name,
                "기관명": org_name,
                "기관ID": org_id,
                "통계표ID": tbl_id,
                "수록기간": f"{start_prd} ~ {end_prd}",
                "수록주기": cycle,
                "수록기간시작일": start_prd,
                "수록기간종료일": end_prd,
                "행정구역": [region_name],
                "매칭경로": match_types,
                "기관수준": self.classify_agency(org_name),
                "분류항목_df": item_df,
                "검색소스": "e-지방지표",
                "주제명": table.get("주제명", ""),
                "지역코드": region_code,
                "최종갱신일": table.get("SEND_DE", ""),
                "지역지표점수": score,
            })

            if len(results) >= max_results:
                break

        return results

    # ----------------------------------------------------------
    # 유사 항목 검색 (v2: 양방향 검색)
    # ----------------------------------------------------------
    def find_similar_tables(self, region, item_keyword, max_results=20, callback=None):
        """
        양방향 검색으로 유사 항목이 포함된 통계표를 찾습니다.

        [양방향이란?]
        정방향: "상주시"로 검색 → 결과에서 "급수량" 분류항목 찾기
        역방향: "급수량"으로 검색 → 결과에서 "상주시" 분류항목 찾기

        [왜 양방향이 필요한가?]
        KOSIS 통합검색은 키워드 기반이라, "상주시" 검색 결과에
        상수도 관련 통계표가 안 나올 수 있음.
        역방향으로 하면 "급수량" 관련 통계표를 먼저 잡고,
        그 안에 "상주시" 데이터가 있는지 확인하는 거라 더 정확함.
        """
        matched_tables = []
        # 중복 방지용: (기관ID, 통계표ID) 쌍을 기록
        seen = set()

        # ── 정방향: 지역명으로 검색 → 항목 키워드 찾기 ─────
        if callback:
            callback(0, f"[정방향] '{region}'으로 검색 중...")

        search_df = self.search(region, max_results=max_results)
        if search_df is not None:
            total = len(search_df)
            for i, row in search_df.iterrows():
                org_id = row.get('기관ID', '')
                tbl_id = row.get('통계표ID', '')
                tbl_name = row.get('통계표명', '')

                if not org_id or not tbl_id:
                    continue

                if callback:
                    progress = int((i + 1) / total * 25)  # 0~25%
                    callback(progress, f"[정방향] ({i+1}/{total}) {tbl_name[:20]}...")

                cat_df = self.get_categories(org_id, tbl_id)
                if cat_df is None:
                    continue

                if '분류값명' in cat_df.columns:
                    matched = cat_df[
                        cat_df['분류값명'].str.contains(item_keyword, na=False)
                    ]['분류값명'].tolist()

                    if matched:
                        key = (org_id, tbl_id)
                        if key not in seen:
                            seen.add(key)
                            matched_tables.append({
                                '통계표명': tbl_name,
                                '기관명': row.get('기관명', ''),
                                '기관ID': org_id,
                                '통계표ID': tbl_id,
                                '수록기간시작일': row.get('수록기간시작일', '?'),
                                '수록기간종료일': row.get('수록기간종료일', '?'),
                                '매칭항목': matched,
                                '검색방향': '정방향',
                            })

        # ── 역방향: 항목 키워드로 검색 → 지역명 찾기 ─────
        if callback:
            callback(30, f"[역방향] '{item_keyword}'으로 검색 중...")

        reverse_df = self.search(item_keyword, max_results=max_results)
        if reverse_df is not None:
            total = len(reverse_df)
            for i, row in reverse_df.iterrows():
                org_id = row.get('기관ID', '')
                tbl_id = row.get('통계표ID', '')
                tbl_name = row.get('통계표명', '')

                if not org_id or not tbl_id:
                    continue

                # 이미 정방향에서 찾은 거면 스킵
                key = (org_id, tbl_id)
                if key in seen:
                    continue

                if callback:
                    progress = 30 + int((i + 1) / total * 65)  # 30~95%
                    callback(progress, f"[역방향] ({i+1}/{total}) {tbl_name[:20]}...")

                cat_df = self.get_categories(org_id, tbl_id)
                if cat_df is None:
                    continue

                if '분류값명' in cat_df.columns:
                    # 지역명이 분류항목에 있는지 확인
                    has_region = cat_df[
                        cat_df['분류값명'].str.contains(region, na=False)
                    ]['분류값명'].tolist()

                    # 항목 키워드도 분류항목에 있는지 확인
                    has_item = cat_df[
                        cat_df['분류값명'].str.contains(item_keyword, na=False)
                    ]['분류값명'].tolist()

                    if has_region and has_item:
                        seen.add(key)
                        matched_tables.append({
                            '통계표명': tbl_name,
                            '기관명': row.get('기관명', ''),
                            '기관ID': org_id,
                            '통계표ID': tbl_id,
                            '수록기간시작일': row.get('수록기간시작일', '?'),
                            '수록기간종료일': row.get('수록기간종료일', '?'),
                            '매칭항목': has_item,
                            '검색방향': '역방향',
                        })

        if callback:
            callback(100, f"완료! 총 {len(matched_tables)}건 발견")

        return matched_tables

    def _init_result_folders(self, sido, sigungu):
        folders = {}
        if sigungu and sigungu != "전체":
            folders[sigungu] = []
        if sido and sido != "전국":
            folders[sido] = []
        folders["전국"] = []
        folders["중복"] = []
        folders["미분류"] = []
        return folders

    def _add_table_to_folders(self, folders, table_info):
        """표준 table_info 딕셔너리를 행정구역 폴더에 넣습니다."""
        region_levels = table_info.get("행정구역") or ["미분류"]

        if len(region_levels) == 1 and region_levels[0] == "미분류":
            folders.setdefault("미분류", []).append(table_info)
        elif len(region_levels) > 1:
            for level in region_levels:
                folders.setdefault(level, []).append(table_info)
            folders.setdefault("중복", []).append(table_info)
        else:
            folders.setdefault(region_levels[0], []).append(table_info)

    def _table_key(self, org_id, tbl_id):
        return str(org_id), str(tbl_id)

    # ----------------------------------------------------------
    # 기본 검색 + 역방향 보완 (v2 개선)
    # ----------------------------------------------------------
    def search_and_classify(
        self,
        sido,
        sigungu,
        keyword,
        max_results=30,
        callback=None,
        include_subregion_search=False,
    ):
        """
        검색 후 결과를 행정구역별로 분류하고 매칭 경로를 분석합니다.

        [v2 개선사항]
        기본 검색("상주시 수도") 결과에 추가로,
        역방향 검색("수도"로 검색 → "상주시" 포함 여부 확인)
        결과를 합쳐서 누락을 줄임.
        """
        region_name = sigungu if (sigungu and sigungu != "전체") else sido
        search_terms = self.build_search_terms(sido, sigungu, keyword)

        if callback:
            callback(0, f"확장 검색어 {len(search_terms)}개 준비")

        def search_callback(progress, message):
            if callback:
                callback(int(progress * 0.14), message)

        # ── 1단계: 단순 검색어를 내부 확장 검색어로 넓혀 후보 수집 ─────
        combined_df = self.search_many(
            search_terms,
            result_count=min(max_results, SEARCH_RESULT_COUNT_PER_TERM),
            callback=search_callback,
        )

        if include_subregion_search and sigungu and sigungu != "전체":
            subregion_terms = self.build_subregion_search_terms(sido, sigungu, keyword)
            if subregion_terms:
                if callback:
                    callback(15, f"읍면동 {len(subregion_terms)}개 보강검색 준비")

                def subregion_callback(progress, message):
                    if callback:
                        callback(15 + int(progress * 0.10), message)

                subregion_df = self.search_many(
                    subregion_terms,
                    result_count=min(max_results, SUBREGION_SEARCH_RESULT_COUNT),
                    callback=subregion_callback,
                )
                combined_df = self._merge_results(combined_df, subregion_df)

        folders = self._init_result_folders(sido, sigungu)
        seen = set()
        table_infos = []
        total = 0

        if combined_df is not None and len(combined_df) > 0:
            total = len(combined_df)
            candidate_rows = []
            for _, row in combined_df.iterrows():
                if row.get('기관ID', '') and row.get('통계표ID', ''):
                    candidate_rows.append(row)

            candidate_rows.sort(
                key=lambda row: self.quick_candidate_score(
                    row, keyword, sido=sido, sigungu=sigungu
                ),
                reverse=True,
            )
            eval_total = min(
                len(candidate_rows),
                max_results,
                SEARCH_PRECISION_EVALUATION_LIMIT,
            )

            if callback:
                callback(20, f"후보 {total}건 발견. 상위 {eval_total}건 정밀평가 시작...")

            # ── 2단계: 간단평가 상위 통계표만 메타 정밀평가 ─────────
            for i, row in enumerate(candidate_rows[:eval_total]):
                org_id = row.get('기관ID', '')
                tbl_id = row.get('통계표ID', '')
                tbl_name = row.get('통계표명', '')
                org_name = row.get('기관명', '')
                tbl_content = row.get('통계표주요내용', '')
                start_prd = row.get('수록기간시작일', '?')
                end_prd = row.get('수록기간종료일', '?')

                if not org_id or not tbl_id:
                    continue

                progress = 20 + int((i + 1) / max(1, eval_total) * 55)  # 20~75%
                if callback:
                    callback(progress, f"({i+1}/{eval_total}) {tbl_name[:25]}... 정밀평가 중")

                cat_df = self.get_table_meta_items(org_id, tbl_id)
                if cat_df is None:
                    cat_df = self.get_categories(org_id, tbl_id)
                region_levels = self.classify_region_level(cat_df, sido, sigungu)
                matched_term = row.get('검색어', f"{region_name} {keyword}")
                match_types = self.analyze_match_type(matched_term, tbl_name, tbl_content, cat_df)
                agency_level = self.classify_agency(org_name)

                table_info = {
                    '통계표명': tbl_name,
                    '기관명': org_name,
                    '기관ID': org_id,
                    '통계표ID': tbl_id,
                    '수록기간': f"{start_prd} ~ {end_prd}",
                    '수록기간시작일': start_prd,
                    '수록기간종료일': end_prd,
                    '행정구역': region_levels,
                    '매칭경로': match_types,
                    '기관수준': agency_level,
                    '분류항목_df': cat_df,
                    '검색소스': 'KOSIS통합검색',
                    '검색어': matched_term,
                    '간단평가점수': self.quick_candidate_score(
                        row, keyword, sido=sido, sigungu=sigungu
                    ),
                }
                self.enrich_recommendation(table_info, keyword, region_name=region_name)

                table_infos.append(table_info)
                seen.add(self._table_key(org_id, tbl_id))

        # ── 3단계: e-지방지표 전용 검색으로 보강 ───────────────
        local_tables = []
        if self._is_future_population_query(keyword):
            if callback:
                callback(78, "[지역지표] 장래인구는 통합검색 후보를 우선 사용")
        else:
            if callback:
                callback(78, f"[지역지표] '{keyword}' 후보 확인 중...")

            def local_callback(progress, message):
                if callback:
                    callback(78 + int(progress * 0.20), message)

            local_tables = self.search_local_indicators(
                sido, sigungu, keyword,
                max_results=min(max_results, 12),
                callback=local_callback,
            )

        added_local = 0
        for table_info in local_tables:
            key = self._table_key(table_info.get('기관ID', ''), table_info.get('통계표ID', ''))
            if key in seen:
                continue
            self.enrich_recommendation(table_info, keyword, region_name=region_name)
            table_infos.append(table_info)
            seen.add(key)
            added_local += 1

        table_infos.sort(
            key=lambda item: (
                item.get("추천점수", 0),
                str(item.get("최신시점", "")),
            ),
            reverse=True,
        )

        for table_info in table_infos:
            self._add_table_to_folders(folders, table_info)

        folders = {k: v for k, v in folders.items() if v}

        if not folders:
            if callback:
                callback(100, "검색 결과 없음")
            return None

        if callback:
            total_found = sum(len(v) for v in folders.values())
            callback(
                100,
                f"완료! 통합검색 {total}건 + 지역지표 {added_local}건, 폴더 {len(folders)}개 생성"
            )

        return folders

    # ----------------------------------------------------------
    # 검색 결과 합치기 (중복 제거)
    # ----------------------------------------------------------
    def _merge_results(self, df1, df2):
        """
        두 검색 결과를 합치고 중복(같은 기관ID+통계표ID)을 제거합니다.

        [왜 필요한가?]
        "상주시 수도"와 "수도" 검색 결과에 같은 통계표가
        겹칠 수 있음. 중복을 제거해야 불필요한 API 호출을 줄임.
        """
        if df1 is None and df2 is None:
            return None
        if df1 is None:
            return df2
        if df2 is None:
            return df1

        # 합치기
        combined = pd.concat([df1, df2], ignore_index=True)

        # 중복 제거 (기관ID + 통계표ID 기준)
        if '기관ID' in combined.columns and '통계표ID' in combined.columns:
            combined = combined.drop_duplicates(
                subset=['기관ID', '통계표ID'], keep='first'
            )

        return combined.reset_index(drop=True)

    # ----------------------------------------------------------
    # 콘솔 탐색용 출력 헬퍼
    # ----------------------------------------------------------
    def print_search_results(self, results):
        """main.py 같은 콘솔 스크립트에서 검색 결과를 보기 좋게 출력합니다."""
        if results is None or len(results) == 0:
            print("검색 결과가 없습니다.")
            return

        cols = ['기관명', '통계표명', '기관ID', '통계표ID', '수록기간시작일', '수록기간종료일']
        available_cols = [col for col in cols if col in results.columns]
        print(f"검색 결과: {len(results)}건")
        print(results[available_cols].to_string(index=False))

    def print_categories(self, cat_df, limit=30):
        """분류항목 DataFrame을 분류명별로 출력합니다."""
        if cat_df is None or len(cat_df) == 0:
            print("분류항목 정보가 없습니다.")
            return

        if '분류명' not in cat_df.columns or '분류값명' not in cat_df.columns:
            print(cat_df.to_string(index=False))
            return

        for name, group in cat_df.groupby('분류명'):
            items = group['분류값명'].tolist()
            print(f"\n[{name}] {len(items)}개")
            for idx, item in enumerate(items[:limit], 1):
                print(f"  {idx}. {item}")
            if len(items) > limit:
                print(f"  ... 외 {len(items) - limit}개")

    def print_similar_results(self, results):
        """유사 항목 검색 결과를 출력합니다."""
        if not results:
            print("유사 항목 검색 결과가 없습니다.")
            return

        print(f"유사 항목 검색 결과: {len(results)}건")
        for idx, row in enumerate(results, 1):
            period = f"{row.get('수록기간시작일', '?')} ~ {row.get('수록기간종료일', '?')}"
            matched = ", ".join(row.get('매칭항목', [])[:5])
            print(f"{idx}. {row.get('통계표명', '')} | {row.get('기관명', '')} | {period}")
            print(f"   방향: {row.get('검색방향', '')} | 매칭: {matched}")

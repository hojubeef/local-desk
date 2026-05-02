"""Local Desk web server for the KOSIS module.

This intentionally uses only the Python standard library so the local portal
can run without installing a separate web framework.
"""

from __future__ import annotations

import argparse
import ast
import base64
import datetime as dt
import hashlib
import html as html_lib
import json
import re
import secrets
import sys
import threading
import time
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - old Python fallback
    ZoneInfo = None


APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parents[1]

if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from config import KOSIS_API_KEY  # noqa: E402
from kosis_client import KosisClient  # noqa: E402


CLIENT = KosisClient(KOSIS_API_KEY)
JOBS = {}
JOB_LOCK = threading.Lock()
JOB_TTL_SECONDS = 600
ASSET_VERSION = "20260502-google-calendar"
PORTAL_DATA_PATH = ROOT_DIR / "portal" / "data" / "portal-data.json"
LOCAL_DIR = ROOT_DIR / "local"
GOOGLE_CREDENTIALS_PATH = LOCAL_DIR / "secrets" / "google-calendar-credentials.json"
GOOGLE_TOKEN_PATH = LOCAL_DIR / "secrets" / "google-calendar-token.json"
GOOGLE_CALENDAR_ALL = "__all__"
GOOGLE_CALENDAR_SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
]
GOOGLE_TIME_ZONE = "Asia/Seoul"
GOOGLE_OAUTH_STATES = {}
GOOGLE_OAUTH_LOCK = threading.Lock()


def load_region_data() -> dict[str, list[str]]:
    """Read REGION_DATA from app.py without importing the Tkinter GUI."""
    app_py = APP_DIR / "app.py"
    tree = ast.parse(app_py.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "REGION_DATA":
                return ast.literal_eval(node.value)
    return {"전국": ["전체"]}


REGION_DATA = load_region_data()


def safe_text(value, fallback=""):
    if value is None:
        return fallback
    text = str(value)
    return text if text != "nan" else fallback


def category_groups(table_info):
    df = table_info.get("분류항목_df")
    if df is None or len(df) == 0 or "분류명" not in df.columns or "분류값명" not in df.columns:
        return []

    groups = []
    for name, group in df.groupby("분류명"):
        values = [safe_text(value) for value in group["분류값명"].tolist()]
        groups.append({
            "name": safe_text(name, "분류"),
            "count": len(values),
            "values": values[:24],
        })
    return groups


def parse_optional_int(value):
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def extract_year(value):
    match = re.search(r"(19|20|21)\d{2}", safe_text(value))
    if not match:
        return None
    return int(match.group(0))


def year_check_for_table(table_info, criteria):
    report_year = criteria.get("report_year")
    if not report_year:
        return None

    window_years = max(1, int(criteria.get("year_window") or 5))
    include_latest = bool(criteria.get("include_latest_data", True))
    window_start = report_year - window_years + 1

    start_year = extract_year(table_info.get("수록기간시작일") or table_info.get("수록기간"))
    end_year = extract_year(
        table_info.get("최신시점")
        or table_info.get("수록기간종료일")
        or table_info.get("수록기간")
    )
    if start_year and not end_year:
        end_year = start_year
    if end_year and not start_year:
        start_year = end_year

    fetch_end_year = report_year
    has_recent_after_report = bool(end_year and end_year > report_year)
    if include_latest and has_recent_after_report:
        fetch_end_year = end_year

    if not start_year or not end_year:
        return {
            "reportYear": report_year,
            "windowYears": window_years,
            "windowStartYear": window_start,
            "windowEndYear": report_year,
            "fetchStartYear": window_start,
            "fetchEndYear": fetch_end_year,
            "periodStartYear": start_year,
            "periodEndYear": end_year,
            "hasReportYear": False,
            "hasWindowData": False,
            "hasRecentAfterReportYear": has_recent_after_report,
            "status": "unknown",
            "label": "기간 미확인",
            "rangeLabel": f"{window_start}~{report_year}",
            "fetchRangeLabel": f"{window_start}~{fetch_end_year}",
        }

    has_report_year = start_year <= report_year <= end_year
    has_window_data = end_year >= window_start and start_year <= report_year

    if has_report_year:
        status = "contains"
        label = f"{report_year} 포함"
    elif has_window_data:
        status = "window"
        label = f"{window_years}년 이내 자료 있음"
    elif end_year < window_start:
        status = "old"
        label = f"{end_year}까지"
    elif start_year > report_year:
        status = "future"
        label = f"{start_year}부터"
    else:
        status = "missing"
        label = "기준기간 자료 없음"

    return {
        "reportYear": report_year,
        "windowYears": window_years,
        "windowStartYear": window_start,
        "windowEndYear": report_year,
        "fetchStartYear": window_start,
        "fetchEndYear": fetch_end_year,
        "periodStartYear": start_year,
        "periodEndYear": end_year,
        "hasReportYear": has_report_year,
        "hasWindowData": has_window_data,
        "hasRecentAfterReportYear": has_recent_after_report,
        "status": status,
        "label": label,
        "rangeLabel": f"{window_start}~{report_year}",
        "fetchRangeLabel": f"{window_start}~{fetch_end_year}",
    }


def data_options_payload(options):
    return {
        "items": options.get("items", []),
        "objects": options.get("objects", []),
        "period": options.get("period", {}),
        "regionMatch": options.get("region_match"),
        "summaries": CLIENT.summarize_selection_options(options),
    }


def dataframe_payload(df, max_rows=300):
    if df is None or len(df) == 0:
        return {
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "displayedRows": 0,
        }

    columns = [safe_text(col) for col in df.columns.tolist()]
    rows = []
    for _, row in df.head(max_rows).iterrows():
        rows.append({
            col: safe_text(row.get(col))
            for col in columns
        })

    return {
        "columns": columns,
        "rows": rows,
        "rowCount": int(len(df)),
        "displayedRows": len(rows),
    }


def table_to_payload(table_info, criteria=None):
    criteria = criteria or {}
    return {
        "title": safe_text(table_info.get("통계표명")),
        "agency": safe_text(table_info.get("기관명")),
        "orgId": safe_text(table_info.get("기관ID")),
        "tableId": safe_text(table_info.get("통계표ID")),
        "period": safe_text(table_info.get("수록기간")),
        "startPeriod": safe_text(table_info.get("수록기간시작일")),
        "endPeriod": safe_text(table_info.get("수록기간종료일")),
        "regions": [safe_text(value) for value in table_info.get("행정구역", [])],
        "matchTypes": [safe_text(value) for value in table_info.get("매칭경로", [])],
        "agencyLevel": safe_text(table_info.get("기관수준")),
        "source": safe_text(table_info.get("검색소스"), "KOSIS통합검색"),
        "topic": safe_text(table_info.get("주제명")),
        "regionCode": safe_text(table_info.get("지역코드")),
        "score": table_info.get("추천점수", 0),
        "grade": safe_text(table_info.get("추천도"), "보통"),
        "reason": safe_text(table_info.get("추천사유")),
        "regionSummary": safe_text(table_info.get("지역수준요약"), "미확인"),
        "detailSummary": safe_text(table_info.get("세부분류요약"), "미확인"),
        "latest": safe_text(table_info.get("최신시점") or table_info.get("수록기간종료일"), "?"),
        "yearCheck": year_check_for_table(table_info, criteria),
        "categories": category_groups(table_info),
    }


def folders_to_payload(folders, criteria=None):
    if not folders:
        return []
    return [
        {
            "name": name,
            "count": len(tables),
            "tables": [table_to_payload(table, criteria) for table in tables],
        }
        for name, tables in folders.items()
    ]


def cleanup_jobs():
    now = time.time()
    with JOB_LOCK:
        stale_ids = [
            job_id
            for job_id, job in JOBS.items()
            if job.get("finishedAt") and now - job["finishedAt"] > JOB_TTL_SECONDS
        ]
        for job_id in stale_ids:
            JOBS.pop(job_id, None)


def update_job(job_id, **updates):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(updates)


def get_job_snapshot(job_id):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return None
        return dict(job)


def validate_search_body(body):
    sido = safe_text(body.get("sido"))
    sigungu = safe_text(body.get("sigungu"), "전체")
    keyword = safe_text(body.get("keyword")).strip()
    include_subregion = bool(body.get("includeSubregionSearch", True))
    report_year = parse_optional_int(body.get("reportYear"))
    year_window_raw = safe_text(body.get("yearWindow"), "5")
    custom_year_window = parse_optional_int(body.get("customYearWindow"))
    if year_window_raw == "custom":
        year_window = custom_year_window or 5
    else:
        year_window = parse_optional_int(year_window_raw) or 5
    include_latest_data = bool(body.get("includeLatestData", True))

    if not sido or not keyword:
        raise ValueError("시/도와 키워드가 필요합니다.")
    if report_year is not None and not 1900 <= report_year <= 2100:
        raise ValueError("보고서 기준년도는 1900~2100 사이로 입력해주세요.")

    return {
        "sido": sido,
        "sigungu": sigungu,
        "keyword": keyword,
        "include_subregion": include_subregion,
        "report_year": report_year,
        "year_window": max(1, min(100, year_window)),
        "include_latest_data": include_latest_data,
    }


def run_search(params, callback=None):
    CLIENT.begin_api_usage_session()
    folders = CLIENT.search_and_classify(
        sido=params["sido"],
        sigungu=params["sigungu"],
        keyword=params["keyword"],
        include_subregion_search=params["include_subregion"],
        callback=callback,
    )
    payload_folders = folders_to_payload(folders, params)
    total = sum(folder["count"] for folder in payload_folders)
    return {
        "ok": True,
        "sido": params["sido"],
        "sigungu": params["sigungu"],
        "keyword": params["keyword"],
        "total": total,
        "folders": payload_folders,
        "criteria": {
            "reportYear": params.get("report_year"),
            "yearWindow": params.get("year_window"),
            "includeLatestData": params.get("include_latest_data"),
        },
        "apiUsage": CLIENT.get_api_usage_snapshot(),
    }


def start_search_job(params):
    cleanup_jobs()
    job_id = uuid.uuid4().hex
    started_at = time.time()
    with JOB_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "status": "running",
            "progress": 1,
            "message": "검색 준비 중...",
            "startedAt": started_at,
            "finishedAt": None,
            "apiUsage": CLIENT.get_api_usage_snapshot(),
            "result": None,
            "error": None,
        }

    def progress_callback(progress, message):
        update_job(
            job_id,
            progress=max(1, min(99, int(progress))),
            message=safe_text(message, "검색 중..."),
            apiUsage=CLIENT.get_api_usage_snapshot(),
        )

    def worker():
        try:
            update_job(job_id, progress=2, message="검색 시작...")
            result = run_search(params, callback=progress_callback)
            update_job(
                job_id,
                status="done",
                progress=100,
                message=f"검색 완료: {result['total']}건",
                result=result,
                apiUsage=result.get("apiUsage"),
                finishedAt=time.time(),
            )
        except Exception as error:
            update_job(
                job_id,
                status="error",
                progress=100,
                message=safe_text(error),
                error=safe_text(error),
                apiUsage=CLIENT.get_api_usage_snapshot(),
                finishedAt=time.time(),
            )

    threading.Thread(target=worker, daemon=True).start()
    return get_job_snapshot(job_id)


class GoogleCalendarError(Exception):
    pass


class GoogleCalendarAuthRequired(GoogleCalendarError):
    pass


def relative_workspace_path(path):
    try:
        return str(path.relative_to(ROOT_DIR)).replace("\\", "/")
    except ValueError:
        return str(path)


def read_json_file(path):
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_json_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write("\n")
    temp_path.replace(path)


def sanitize_portal_data_for_git(data):
    if not isinstance(data, dict):
        return data
    sanitized = dict(data)
    events = sanitized.get("events")
    if isinstance(events, list):
        sanitized["events"] = [
            event for event in events
            if not (isinstance(event, dict) and (event.get("source") == "google" or event.get("externalId")))
        ]
    calendar_settings = sanitized.get("calendarSettings")
    if isinstance(calendar_settings, dict):
        calendar_settings = dict(calendar_settings)
        google = calendar_settings.get("google")
        if isinstance(google, dict):
            google = dict(google)
            google["calendarId"] = "__all__"
            google["lastSyncAt"] = ""
            calendar_settings["google"] = google
        sanitized["calendarSettings"] = calendar_settings
    return sanitized


def google_credentials():
    if not GOOGLE_CREDENTIALS_PATH.exists():
        raise GoogleCalendarError(
            f"{relative_workspace_path(GOOGLE_CREDENTIALS_PATH)} 파일이 필요합니다."
        )
    data = read_json_file(GOOGLE_CREDENTIALS_PATH)
    config = data.get("installed") or data.get("web") or {}
    client_id = config.get("client_id")
    auth_uri = config.get("auth_uri", "https://accounts.google.com/o/oauth2/auth")
    token_uri = config.get("token_uri", "https://oauth2.googleapis.com/token")
    if not client_id:
        raise GoogleCalendarError("Google OAuth client_id를 찾을 수 없습니다.")
    return {
        "client_id": client_id,
        "client_secret": config.get("client_secret", ""),
        "auth_uri": auth_uri,
        "token_uri": token_uri,
    }


def read_google_token():
    if not GOOGLE_TOKEN_PATH.exists():
        return None
    return read_json_file(GOOGLE_TOKEN_PATH)


def save_google_token(token):
    write_json_file(GOOGLE_TOKEN_PATH, token)


def oauth_code_verifier():
    return secrets.token_urlsafe(96)[:128]


def oauth_code_challenge(verifier):
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def token_is_valid(token):
    return bool(token and token.get("access_token") and token.get("expires_at", 0) > time.time() + 60)


def google_token_scopes(token):
    if not token:
        return set()
    return set(safe_text(token.get("scope")).split())


def google_token_has_required_scopes(token):
    return set(GOOGLE_CALENDAR_SCOPES).issubset(google_token_scopes(token))


def post_form(url, data):
    encoded = urlencode(data).encode("utf-8")
    request = Request(
        url,
        data=encoded,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def exchange_google_code(code, redirect_uri, code_verifier):
    config = google_credentials()
    form = {
        "code": code,
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    if code_verifier:
        form["code_verifier"] = code_verifier
    payload = post_form(config["token_uri"], form)
    now = time.time()
    token = {
        "access_token": payload.get("access_token"),
        "refresh_token": payload.get("refresh_token"),
        "token_type": payload.get("token_type", "Bearer"),
        "scope": payload.get("scope", " ".join(GOOGLE_CALENDAR_SCOPES)),
        "expires_at": now + int(payload.get("expires_in", 3600)) - 60,
        "created_at": now,
    }
    if not token["refresh_token"]:
        old_token = read_google_token() or {}
        token["refresh_token"] = old_token.get("refresh_token")
    if not token["access_token"]:
        raise GoogleCalendarError("Google access token을 받지 못했습니다.")
    save_google_token(token)
    return token


def refresh_google_token(token):
    refresh_token = token.get("refresh_token")
    if not refresh_token:
        raise GoogleCalendarAuthRequired("Google Calendar 연결이 필요합니다.")
    config = google_credentials()
    payload = post_form(config["token_uri"], {
        "client_id": config["client_id"],
        "client_secret": config["client_secret"],
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    })
    now = time.time()
    updated = {
        **token,
        "access_token": payload.get("access_token"),
        "token_type": payload.get("token_type", token.get("token_type", "Bearer")),
        "scope": payload.get("scope", token.get("scope", " ".join(GOOGLE_CALENDAR_SCOPES))),
        "expires_at": now + int(payload.get("expires_in", 3600)) - 60,
        "refreshed_at": now,
    }
    if not updated["access_token"]:
        raise GoogleCalendarAuthRequired("Google access token 갱신에 실패했습니다.")
    save_google_token(updated)
    return updated


def ensure_google_access_token():
    token = read_google_token()
    if not token:
        raise GoogleCalendarAuthRequired("Google Calendar 연결이 필요합니다.")
    if not google_token_has_required_scopes(token):
        raise GoogleCalendarAuthRequired("Google Calendar 권한이 바뀌어서 다시 연결이 필요합니다.")
    if token_is_valid(token):
        return token["access_token"]
    return refresh_google_token(token)["access_token"]


def google_api_request(url, access_token, method="GET", payload=None):
    body = None
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except Exception as error:
        detail = str(error)
        if hasattr(error, "read"):
            try:
                detail = error.read().decode("utf-8")
            except Exception:
                detail = str(error)
        raise GoogleCalendarError(f"Google Calendar API 오류: {detail[:500]}")


def list_google_calendars(access_token):
    calendars = []
    page_token = ""
    while True:
        params = {
            "maxResults": "250",
            "minAccessRole": "reader",
        }
        if page_token:
            params["pageToken"] = page_token
        url = f"https://www.googleapis.com/calendar/v3/users/me/calendarList?{urlencode(params)}"
        payload = google_api_request(url, access_token)
        for item in payload.get("items", []):
            calendar_id = safe_text(item.get("id"))
            if not calendar_id:
                continue
            calendars.append({
                "id": calendar_id,
                "name": safe_text(item.get("summary"), calendar_id),
                "primary": bool(item.get("primary")),
                "accessRole": safe_text(item.get("accessRole")),
                "backgroundColor": safe_text(item.get("backgroundColor")),
            })
        page_token = safe_text(payload.get("nextPageToken"))
        if not page_token:
            break
    calendars.sort(key=lambda item: (not item["primary"], item["name"].lower()))
    return calendars


def parse_calendar_month(value):
    match = re.match(r"^(\d{4})-(\d{2})$", safe_text(value))
    if not match:
        today = dt.date.today()
        return today.year, today.month
    year = int(match.group(1))
    month = max(1, min(12, int(match.group(2))))
    return year, month


def month_bounds(month_value):
    year, month = parse_calendar_month(month_value)
    start = dt.date(year, month, 1)
    if month == 12:
        end = dt.date(year + 1, 1, 1)
    else:
        end = dt.date(year, month + 1, 1)
    return start, end


def month_bound_rfc3339(date_value):
    return f"{date_value.isoformat()}T00:00:00+09:00"


def local_datetime(date_value, time_value):
    parsed = dt.datetime.strptime(f"{date_value} {time_value}", "%Y-%m-%d %H:%M")
    if ZoneInfo:
        return parsed.replace(tzinfo=ZoneInfo(GOOGLE_TIME_ZONE))
    return parsed


def google_datetime_value(value):
    if ZoneInfo and value.tzinfo is not None:
        return value.astimezone(ZoneInfo(GOOGLE_TIME_ZONE)).isoformat(timespec="seconds")
    return value.isoformat(timespec="seconds")


def local_event_to_google(event):
    title = safe_text(event.get("title"), "Local Desk 일정")
    date_value = safe_text(event.get("date"))
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date_value):
        raise GoogleCalendarError("일정 날짜 형식이 올바르지 않습니다.")
    notes = safe_text(event.get("notes"))
    tags = event.get("tags") if isinstance(event.get("tags"), list) else []
    description_parts = [notes] if notes else []
    if tags:
        description_parts.append("Tags: " + ", ".join(safe_text(tag) for tag in tags))

    start_time = safe_text(event.get("startTime"))
    end_time = safe_text(event.get("endTime"))
    payload = {
        "summary": title,
        "description": "\n\n".join(description_parts),
    }
    if start_time:
        start_dt = local_datetime(date_value, start_time)
        end_dt = local_datetime(date_value, end_time) if end_time else start_dt + dt.timedelta(hours=1)
        if end_dt <= start_dt:
            end_dt = end_dt + dt.timedelta(days=1)
        payload["start"] = {"dateTime": google_datetime_value(start_dt), "timeZone": GOOGLE_TIME_ZONE}
        payload["end"] = {"dateTime": google_datetime_value(end_dt), "timeZone": GOOGLE_TIME_ZONE}
    else:
        start_date = dt.date.fromisoformat(date_value)
        payload["start"] = {"date": start_date.isoformat()}
        payload["end"] = {"date": (start_date + dt.timedelta(days=1)).isoformat()}
    return payload


def parse_google_event_time(value):
    if not value:
        return "", ""
    if "T" not in value:
        return value[:10], ""
    raw = value.replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(raw)
    if ZoneInfo and parsed.tzinfo is not None:
        parsed = parsed.astimezone(ZoneInfo(GOOGLE_TIME_ZONE))
    return parsed.date().isoformat(), parsed.strftime("%H:%M")


def google_event_to_local(item, calendar_id="primary", calendar_name="Google Calendar"):
    external_id = safe_text(item.get("id"))
    start = item.get("start", {})
    end = item.get("end", {})
    date_value, start_time = parse_google_event_time(start.get("dateTime") or start.get("date"))
    _, end_time = parse_google_event_time(end.get("dateTime") or end.get("date"))
    safe_id = re.sub(r"[^A-Za-z0-9_-]+", "-", external_id)
    safe_calendar_id = re.sub(r"[^A-Za-z0-9_-]+", "-", safe_text(calendar_id, "primary"))
    now_ms = int(time.time() * 1000)
    return {
        "id": f"google-{safe_calendar_id}-{safe_id}",
        "title": safe_text(item.get("summary"), "(제목 없음)"),
        "date": date_value,
        "startTime": start_time,
        "endTime": end_time if start_time else "",
        "notes": safe_text(item.get("description")),
        "categoryId": "event-work",
        "tags": ["Google Calendar", safe_text(calendar_name, "Google Calendar")],
        "source": "google",
        "externalId": external_id,
        "externalCalendarId": safe_text(calendar_id, "primary"),
        "externalCalendarName": safe_text(calendar_name, "Google Calendar"),
        "syncStatus": "synced",
        "createdAt": now_ms,
        "updatedAt": now_ms,
    }


def list_google_events(calendar_id, month_value, access_token, calendar_name="Google Calendar"):
    start, end = month_bounds(month_value)
    params = urlencode({
        "timeMin": month_bound_rfc3339(start),
        "timeMax": month_bound_rfc3339(end),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": "2500",
    })
    encoded_calendar_id = quote(calendar_id or "primary", safe="")
    url = f"https://www.googleapis.com/calendar/v3/calendars/{encoded_calendar_id}/events?{params}"
    payload = google_api_request(url, access_token)
    return [
        google_event_to_local(item, calendar_id, calendar_name)
        for item in payload.get("items", [])
        if item.get("status") != "cancelled"
    ]


def insert_google_event(calendar_id, event, access_token):
    encoded_calendar_id = quote(calendar_id or "primary", safe="")
    url = f"https://www.googleapis.com/calendar/v3/calendars/{encoded_calendar_id}/events"
    created = google_api_request(url, access_token, method="POST", payload=local_event_to_google(event))
    return google_event_to_local(created, calendar_id, calendar_id)


def event_in_month(event, month_value):
    year, month = parse_calendar_month(month_value)
    return safe_text(event.get("date")).startswith(f"{year:04d}-{month:02d}")


class LocalDeskHandler(SimpleHTTPRequestHandler):
    server_version = "LocalDesk/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/health":
            self.write_json({
                "ok": True,
                "module": "kosis",
                "assetVersion": ASSET_VERSION,
                "rootDir": str(ROOT_DIR),
            })
            return
        if path == "/api/kosis/regions":
            self.write_json({"regions": REGION_DATA})
            return
        if path == "/api/kosis/search/status":
            query = parse_qs(parsed.query)
            self.handle_search_status(query.get("id", [""])[0])
            return
        if path == "/api/portal/data":
            self.handle_portal_data_get()
            return
        if path == "/api/calendar/google/status":
            self.handle_google_calendar_status()
            return
        if path == "/api/calendar/google/auth-url":
            self.handle_google_calendar_auth_url()
            return
        if path == "/api/calendar/google/calendars":
            self.handle_google_calendar_calendars()
            return
        if path == "/api/calendar/google/callback":
            self.handle_google_calendar_callback(parsed)
            return
        if path == "/":
            self.path = "/portal/index.html"
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/portal/data":
            self.handle_portal_data_post()
            return
        if path == "/api/calendar/google/sync":
            self.handle_google_calendar_sync()
            return
        if path == "/api/kosis/search":
            self.handle_search()
            return
        if path == "/api/kosis/search/start":
            self.handle_search_start()
            return
        if path == "/api/kosis/options":
            self.handle_options()
            return
        if path == "/api/kosis/preview":
            self.handle_preview()
            return
        self.write_json({"error": "Unknown API endpoint"}, status=404)

    def handle_search(self):
        body = self.read_json_body()
        try:
            self.write_json(run_search(validate_search_body(body)))
        except ValueError as error:
            self.write_json({"error": str(error)}, status=400)
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_search_start(self):
        body = self.read_json_body()
        try:
            job = start_search_job(validate_search_body(body))
            self.write_json({
                "ok": True,
                "jobId": job["id"],
                "status": job["status"],
                "progress": job["progress"],
                "message": job["message"],
            })
        except ValueError as error:
            self.write_json({"error": str(error)}, status=400)
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_search_status(self, job_id):
        cleanup_jobs()
        job = get_job_snapshot(job_id)
        if not job:
            self.write_json({"error": "검색 작업을 찾을 수 없습니다."}, status=404)
            return
        self.write_json(job)

    def handle_options(self):
        body = self.read_json_body()
        org_id = safe_text(body.get("orgId"))
        table_id = safe_text(body.get("tableId"))
        region_name = safe_text(body.get("regionName"))

        if not org_id or not table_id:
            self.write_json({"error": "기관ID와 통계표ID가 필요합니다."}, status=400)
            return

        try:
            options = CLIENT.get_data_selection_options(org_id, table_id, region_name=region_name)
            self.write_json({
                "ok": True,
                "orgId": org_id,
                "tableId": table_id,
                "regionName": region_name,
                "options": data_options_payload(options),
                "apiUsage": CLIENT.get_api_usage_snapshot(),
            })
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_preview(self):
        body = self.read_json_body()
        org_id = safe_text(body.get("orgId"))
        table_id = safe_text(body.get("tableId"))
        region_name = safe_text(body.get("regionName"))
        item_ids = body.get("itemIds")
        latest_count = parse_optional_int(body.get("latestCount")) or 5
        start_period = safe_text(body.get("startPeriod"))
        end_period = safe_text(body.get("endPeriod"))
        obj_selections = body.get("objectSelections") or {}

        if not org_id or not table_id:
            self.write_json({"error": "기관ID와 통계표ID가 필요합니다."}, status=400)
            return

        try:
            df = CLIENT.fetch_selected_data(
                org_id,
                table_id,
                region_name=region_name,
                item_id=item_ids,
                latest_count=latest_count,
                start_period=start_period or None,
                end_period=end_period or None,
                obj_selections=obj_selections,
            )
            payload = dataframe_payload(df)
            payload.update({
                "ok": True,
                "orgId": org_id,
                "tableId": table_id,
                "apiUsage": CLIENT.get_api_usage_snapshot(),
            })
            self.write_json(payload)
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_portal_data_get(self):
        try:
            if not PORTAL_DATA_PATH.exists():
                self.write_json({"ok": True, "data": None, "path": str(PORTAL_DATA_PATH)})
                return
            with PORTAL_DATA_PATH.open("r", encoding="utf-8") as file:
                data = json.load(file)
            self.write_json({"ok": True, "data": data, "path": str(PORTAL_DATA_PATH)})
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_portal_data_post(self):
        try:
            body = self.read_json_body()
            data = body.get("data") if isinstance(body, dict) and "data" in body else body
            data = sanitize_portal_data_for_git(data)
            PORTAL_DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
            temp_path = PORTAL_DATA_PATH.with_suffix(".tmp")
            with temp_path.open("w", encoding="utf-8", newline="\n") as file:
                json.dump(data, file, ensure_ascii=False, indent=2)
                file.write("\n")
            temp_path.replace(PORTAL_DATA_PATH)
            self.write_json({"ok": True, "path": str(PORTAL_DATA_PATH)})
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def google_redirect_uri(self):
        host = self.headers.get("Host", "127.0.0.1:8765")
        return f"http://{host}/api/calendar/google/callback"

    def handle_google_calendar_status(self):
        token = read_google_token()
        configured = GOOGLE_CREDENTIALS_PATH.exists()
        connected = bool(token and (token.get("refresh_token") or token_is_valid(token)))
        needs_reconnect = bool(connected and not google_token_has_required_scopes(token))
        self.write_json({
            "ok": True,
            "configured": configured,
            "connected": connected,
            "needsReconnect": needs_reconnect,
            "credentialsPath": relative_workspace_path(GOOGLE_CREDENTIALS_PATH),
            "tokenPath": relative_workspace_path(GOOGLE_TOKEN_PATH),
            "scopes": GOOGLE_CALENDAR_SCOPES,
            "grantedScopes": sorted(google_token_scopes(token)),
            "message": (
                "Google Calendar 권한 갱신 필요"
                if needs_reconnect else
                "Google Calendar 연결됨"
                if connected else
                "Google OAuth 설정 파일을 찾았습니다. 연결을 진행할 수 있습니다."
                if configured else
                f"{relative_workspace_path(GOOGLE_CREDENTIALS_PATH)} 파일이 필요합니다."
            ),
        })

    def handle_google_calendar_auth_url(self):
        try:
            config = google_credentials()
            state_id = uuid.uuid4().hex
            redirect_uri = self.google_redirect_uri()
            code_verifier = oauth_code_verifier()
            with GOOGLE_OAUTH_LOCK:
                GOOGLE_OAUTH_STATES[state_id] = {
                    "createdAt": time.time(),
                    "redirectUri": redirect_uri,
                    "codeVerifier": code_verifier,
                }
            params = {
                "client_id": config["client_id"],
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": " ".join(GOOGLE_CALENDAR_SCOPES),
                "access_type": "offline",
                "include_granted_scopes": "true",
                "prompt": "consent",
                "state": state_id,
                "code_challenge": oauth_code_challenge(code_verifier),
                "code_challenge_method": "S256",
            }
            self.write_json({
                "ok": True,
                "authUrl": f"{config['auth_uri']}?{urlencode(params)}",
                "redirectUri": redirect_uri,
            })
        except GoogleCalendarError as error:
            self.write_json({"error": str(error)}, status=400)
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_google_calendar_calendars(self):
        try:
            access_token = ensure_google_access_token()
            calendars = list_google_calendars(access_token)
            self.write_json({
                "ok": True,
                "calendars": calendars,
            })
        except GoogleCalendarAuthRequired as error:
            self.write_json({"error": str(error), "authRequired": True}, status=401)
        except GoogleCalendarError as error:
            self.write_json({"error": str(error)}, status=400)
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def handle_google_calendar_callback(self, parsed):
        query = parse_qs(parsed.query)
        if query.get("error"):
            self.write_html(
                "<h1>Google Calendar 연결 실패</h1><p>사용자가 승인을 취소했거나 Google에서 오류를 반환했습니다.</p>",
                status=400,
            )
            return

        code = query.get("code", [""])[0]
        state_id = query.get("state", [""])[0]
        with GOOGLE_OAUTH_LOCK:
            state = GOOGLE_OAUTH_STATES.pop(state_id, None)
        if not code or not state:
            self.write_html("<h1>Google Calendar 연결 실패</h1><p>인증 상태를 확인할 수 없습니다.</p>", status=400)
            return

        try:
            exchange_google_code(code, state["redirectUri"], state.get("codeVerifier"))
            self.write_html(
                "<h1>Google Calendar 연결 완료</h1><p>이 창은 닫고 Local Desk에서 동기화를 누르면 됩니다.</p>"
            )
        except Exception as error:
            self.write_html(
                f"<h1>Google Calendar 연결 실패</h1><p>{html_lib.escape(safe_text(error))}</p>",
                status=500,
            )

    def handle_google_calendar_sync(self):
        try:
            body = self.read_json_body()
            calendar_id = safe_text(body.get("calendarId"), GOOGLE_CALENDAR_ALL) or GOOGLE_CALENDAR_ALL
            month_value = safe_text(body.get("month"))
            local_events = body.get("events") if isinstance(body.get("events"), list) else []
            push_local = bool(body.get("pushLocal"))
            access_token = ensure_google_access_token()
            calendars = list_google_calendars(access_token)
            calendar_map = {calendar["id"]: calendar for calendar in calendars}

            pushed = []
            if push_local:
                target_calendar_id = "primary" if calendar_id == GOOGLE_CALENDAR_ALL else calendar_id
                for event in local_events:
                    if not isinstance(event, dict):
                        continue
                    if safe_text(event.get("source"), "local") != "local":
                        continue
                    if safe_text(event.get("externalId")):
                        continue
                    if not event_in_month(event, month_value):
                        continue
                    created = insert_google_event(target_calendar_id, event, access_token)
                    pushed.append({"localId": safe_text(event.get("id")), "event": created})

            if calendar_id == GOOGLE_CALENDAR_ALL:
                events = []
                for calendar in calendars:
                    if calendar["accessRole"] not in ("reader", "writer", "owner"):
                        continue
                    events.extend(list_google_events(calendar["id"], month_value, access_token, calendar["name"]))
            else:
                calendar = calendar_map.get(calendar_id, {"name": calendar_id})
                events = list_google_events(calendar_id, month_value, access_token, calendar["name"])
            self.write_json({
                "ok": True,
                "calendarId": calendar_id,
                "calendars": calendars,
                "month": month_value,
                "lastSyncAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "events": events,
                "pushed": pushed,
            })
        except GoogleCalendarAuthRequired as error:
            self.write_json({"error": str(error), "authRequired": True}, status=401)
        except GoogleCalendarError as error:
            self.write_json({"error": str(error)}, status=400)
        except Exception as error:
            self.write_json({"error": str(error)}, status=500)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def write_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def write_html(self, html, status=200):
        body = f"<!doctype html><meta charset='utf-8'><title>Google Calendar</title>{html}".encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print("[LocalDesk]", format % args)


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    url = f"http://{args.host}:{args.port}/portal/index.html?v={ASSET_VERSION}"
    try:
        server = ThreadingHTTPServer((args.host, args.port), LocalDeskHandler)
    except OSError as error:
        print(f"Could not start Local Desk on {args.host}:{args.port}: {error}")
        print(f"If Local Desk is already running, open {url}")
        if args.open:
            webbrowser.open(url, new=1, autoraise=True)
        return 1

    print(f"Local Desk running at {url}")
    print("Press Ctrl+C to stop.")
    if args.open:
        webbrowser.open(url, new=1, autoraise=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Local Desk...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

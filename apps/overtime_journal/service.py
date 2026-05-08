"""File-backed overtime journal service.

This module keeps the overtime workflow independent from the existing KOSIS
code.  It stores one JSON file per submitted entry so writes do not collide on
shared drives.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import uuid
from pathlib import Path


JOURNAL_DIR_NAME = "야근일지"
ENTRY_VERSION = 1
MAX_SCAN_DEPTH = 5

DATE_PATTERN = re.compile(
    r"(?P<year>20\d{2})\s*[.\-/년]\s*"
    r"(?P<month>\d{1,2})\s*[.\-/월]\s*"
    r"(?P<day>\d{1,2})\s*(?:일)?\s*(?:\([^)]+\))?"
)
TIME_PATTERN = re.compile(
    r"(?P<start_hour>\d{1,2})(?:\s*[:시]\s*(?P<start_minute>\d{1,2})?\s*(?:분)?)?"
    r"\s*(?:~|-|–|—|부터)\s*"
    r"(?P<end_hour>\d{1,2})(?:\s*[:시]\s*(?P<end_minute>\d{1,2})?\s*(?:분)?)?"
)
FILENAME_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class OvertimeError(ValueError):
    """Raised when an overtime request cannot be handled safely."""


def safe_text(value, fallback=""):
    if value is None:
        return fallback
    return str(value)


def normalize_path(value) -> Path:
    text = safe_text(value).strip().strip('"')
    if not text:
        raise OvertimeError("폴더 경로가 필요합니다.")
    return Path(text).expanduser()


def journal_dir(base_folder) -> Path:
    base = normalize_path(base_folder)
    if base.name == JOURNAL_DIR_NAME:
        return base
    if (base / "entries").exists() or (base / "settings.json").exists():
        return base
    return base / JOURNAL_DIR_NAME


def settings_payload(settings_path: Path) -> dict:
    if not settings_path.exists():
        return {
            "employeeName": "",
            "baseFolder": "",
            "journalDir": "",
            "adminRoot": "",
        }
    try:
        with settings_path.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception:
        data = {}
    base_folder = safe_text(data.get("baseFolder"))
    return {
        "employeeName": safe_text(data.get("employeeName")),
        "baseFolder": base_folder,
        "journalDir": str(journal_dir(base_folder)) if base_folder else "",
        "adminRoot": safe_text(data.get("adminRoot")),
    }


def save_settings(settings_path: Path, data: dict) -> dict:
    payload = {
        "employeeName": safe_text(data.get("employeeName")).strip(),
        "baseFolder": safe_text(data.get("baseFolder")).strip(),
        "adminRoot": safe_text(data.get("adminRoot")).strip(),
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    if payload["baseFolder"]:
        ensure_journal(payload["baseFolder"])
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = settings_path.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
    temp_path.replace(settings_path)
    return settings_payload(settings_path)


def ensure_journal(base_folder) -> Path:
    root = journal_dir(base_folder)
    (root / "entries").mkdir(parents=True, exist_ok=True)
    return root


def _minute(value) -> int:
    if value in (None, ""):
        return 0
    minute = int(value)
    if not 0 <= minute <= 59:
        raise OvertimeError("분은 0~59 사이여야 합니다.")
    return minute


def _hour(value) -> int:
    hour = int(value)
    if not 0 <= hour <= 23:
        raise OvertimeError("시간은 0~23 사이여야 합니다.")
    return hour


def parse_header(line: str) -> dict | None:
    date_match = DATE_PATTERN.search(line)
    time_match = TIME_PATTERN.search(line)
    if not date_match or not time_match:
        return None

    year = int(date_match.group("year"))
    month = int(date_match.group("month"))
    day = int(date_match.group("day"))
    try:
        entry_date = dt.date(year, month, day)
    except ValueError as error:
        raise OvertimeError(f"날짜를 확인해주세요: {error}") from error

    start_hour = _hour(time_match.group("start_hour"))
    start_minute = _minute(time_match.group("start_minute"))
    end_hour = _hour(time_match.group("end_hour"))
    end_minute = _minute(time_match.group("end_minute"))

    start_dt = dt.datetime.combine(entry_date, dt.time(start_hour, start_minute))
    end_dt = dt.datetime.combine(entry_date, dt.time(end_hour, end_minute))
    if end_dt <= start_dt:
        end_dt += dt.timedelta(days=1)
    minutes = int((end_dt - start_dt).total_seconds() // 60)
    if minutes <= 0:
        raise OvertimeError("근무 시간이 0분 이하입니다.")
    if minutes > 24 * 60:
        raise OvertimeError("근무 시간이 24시간을 넘습니다.")

    return {
        "date": entry_date.isoformat(),
        "weekday": "월화수목금토일"[entry_date.weekday()],
        "startTime": f"{start_hour:02d}:{start_minute:02d}",
        "endTime": f"{end_hour:02d}:{end_minute:02d}",
        "minutes": minutes,
        "hours": round(minutes / 60, 2),
        "header": line.strip(),
    }


def parse_entries(raw_text: str, employee_name: str = "") -> dict:
    lines = safe_text(raw_text).replace("\r\n", "\n").replace("\r", "\n").split("\n")
    entries = []
    errors = []
    current = None

    def flush_current():
        if not current:
            return
        work_lines = [line.rstrip() for line in current["workLines"]]
        while work_lines and not work_lines[0].strip():
            work_lines.pop(0)
        while work_lines and not work_lines[-1].strip():
            work_lines.pop()
        work = "\n".join(work_lines).strip()
        parsed = dict(current["parsed"])
        parsed.update({
            "employeeName": employee_name.strip(),
            "work": work,
            "sourceText": "\n".join([current["line"], *work_lines]).strip(),
            "lineNumber": current["lineNumber"],
        })
        if not work:
            parsed["warning"] = "업무내용이 비어 있습니다."
        entries.append(parsed)

    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped:
            if current:
                current["workLines"].append("")
            continue
        try:
            parsed = parse_header(stripped)
        except OvertimeError as error:
            errors.append({"line": index, "text": stripped, "message": str(error)})
            parsed = None
        if parsed:
            flush_current()
            current = {
                "lineNumber": index,
                "line": stripped,
                "parsed": parsed,
                "workLines": [],
            }
        elif current:
            current["workLines"].append(line)
        else:
            errors.append({
                "line": index,
                "text": stripped,
                "message": "날짜와 시간 줄을 먼저 입력해주세요.",
            })
    flush_current()
    return {
        "ok": True,
        "entries": entries,
        "errors": errors,
        "count": len(entries),
    }


def safe_filename_part(value: str, fallback: str = "entry") -> str:
    text = FILENAME_UNSAFE.sub("_", safe_text(value)).strip(" .")
    return text[:40] or fallback


def entry_id(entry: dict, employee_name: str) -> str:
    seed = "|".join([
        safe_text(entry.get("date")),
        safe_text(entry.get("startTime")),
        safe_text(entry.get("endTime")),
        safe_text(employee_name or entry.get("employeeName")),
        safe_text(entry.get("work")),
        uuid.uuid4().hex,
    ])
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:10]
    start = safe_text(entry.get("startTime")).replace(":", "")
    return f"{safe_text(entry.get('date'))}_{start}_{digest}"


def validate_entry(entry: dict, employee_name: str) -> dict:
    date_value = safe_text(entry.get("date"))
    try:
        entry_date = dt.date.fromisoformat(date_value)
    except ValueError as error:
        raise OvertimeError(f"날짜 형식이 올바르지 않습니다: {date_value}") from error

    start_time = safe_text(entry.get("startTime"))
    end_time = safe_text(entry.get("endTime"))
    if not re.fullmatch(r"\d{2}:\d{2}", start_time) or not re.fullmatch(r"\d{2}:\d{2}", end_time):
        raise OvertimeError("시작/종료 시간 형식이 올바르지 않습니다.")

    minutes = int(entry.get("minutes") or 0)
    if minutes <= 0:
        raise OvertimeError("근무 시간이 0분 이하입니다.")

    name = safe_text(entry.get("employeeName") or employee_name).strip()
    if not name:
        raise OvertimeError("이름을 입력해주세요.")

    now = dt.datetime.now(dt.timezone.utc).isoformat()
    normalized = {
        "version": ENTRY_VERSION,
        "id": safe_text(entry.get("id")) or entry_id(entry, name),
        "employeeName": name,
        "date": entry_date.isoformat(),
        "weekday": safe_text(entry.get("weekday")) or "월화수목금토일"[entry_date.weekday()],
        "startTime": start_time,
        "endTime": end_time,
        "minutes": minutes,
        "hours": round(minutes / 60, 2),
        "work": safe_text(entry.get("work")).strip(),
        "sourceText": safe_text(entry.get("sourceText")).strip(),
        "createdAt": safe_text(entry.get("createdAt")) or now,
        "updatedAt": now,
    }
    if safe_text(entry.get("warning")):
        normalized["warning"] = safe_text(entry.get("warning"))
    return normalized


def write_entry(root: Path, entry: dict) -> dict:
    month = safe_text(entry.get("date"))[:7]
    month_dir = root / "entries" / month
    month_dir.mkdir(parents=True, exist_ok=True)
    filename = "_".join([
        safe_filename_part(entry["date"]),
        safe_filename_part(entry["startTime"].replace(":", "")),
        safe_filename_part(entry["endTime"].replace(":", "")),
        safe_filename_part(entry["employeeName"]),
        safe_filename_part(entry["id"][-10:]),
    ]) + ".json"
    path = month_dir / filename
    with path.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(entry, file, ensure_ascii=False, indent=2)
        file.write("\n")
    payload = dict(entry)
    payload["path"] = str(path)
    return payload


def save_entries(base_folder, entries: list[dict], employee_name: str = "") -> dict:
    if not isinstance(entries, list) or not entries:
        raise OvertimeError("저장할 야근일지가 없습니다.")
    root = ensure_journal(base_folder)
    saved = []
    for entry in entries:
        normalized = validate_entry(entry, employee_name)
        saved.append(write_entry(root, normalized))
    return {
        "ok": True,
        "journalDir": str(root),
        "saved": saved,
        "count": len(saved),
    }


def read_entry(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
        if not isinstance(data, dict):
            return None
        data.setdefault("id", path.stem)
        data["path"] = str(path)
        return data
    except Exception:
        return None


def list_entries(base_folder) -> list[dict]:
    root = journal_dir(base_folder)
    entries_root = root / "entries"
    if not entries_root.exists():
        return []
    entries = [entry for entry in (read_entry(path) for path in entries_root.rglob("*.json")) if entry]
    return sorted(entries, key=lambda item: (item.get("date", ""), item.get("startTime", ""), item.get("createdAt", "")), reverse=True)


def delete_entry(base_folder, entry_id_value: str) -> dict:
    root = journal_dir(base_folder)
    entry_id_value = safe_text(entry_id_value).strip()
    if not entry_id_value:
        raise OvertimeError("삭제할 항목 ID가 필요합니다.")
    for path in (root / "entries").rglob("*.json"):
        entry = read_entry(path)
        if entry and safe_text(entry.get("id")) == entry_id_value:
            path.unlink()
            return {"ok": True, "deleted": entry_id_value}
    raise OvertimeError("삭제할 야근일지를 찾지 못했습니다.")


def _walk_dirs(root: Path, max_depth: int = MAX_SCAN_DEPTH):
    queue = [(root, 0)]
    seen = set()
    while queue:
        current, depth = queue.pop(0)
        try:
            resolved = str(current.resolve())
        except Exception:
            resolved = str(current)
        if resolved in seen:
            continue
        seen.add(resolved)
        yield current, depth
        if depth >= max_depth:
            continue
        try:
            children = [Path(child.path) for child in os.scandir(current) if child.is_dir()]
        except OSError:
            continue
        queue.extend((child, depth + 1) for child in children)


def find_journal_dirs(root_folder) -> list[Path]:
    root = normalize_path(root_folder)
    if not root.exists():
        raise OvertimeError("수집 폴더를 찾을 수 없습니다.")

    result = []
    seen = set()
    for folder, _depth in _walk_dirs(root):
        candidates = []
        if folder.name == JOURNAL_DIR_NAME:
            candidates.append(folder)
        if (folder / JOURNAL_DIR_NAME / "entries").exists():
            candidates.append(folder / JOURNAL_DIR_NAME)
        if (folder / "entries").exists() and (folder.name == JOURNAL_DIR_NAME or (folder / "settings.json").exists()):
            candidates.append(folder)
        for candidate in candidates:
            key = str(candidate.resolve()) if candidate.exists() else str(candidate)
            if key not in seen:
                seen.add(key)
                result.append(candidate)
    return result


def collect_entries(root_folder) -> dict:
    journal_dirs = find_journal_dirs(root_folder)
    entries = []
    for folder in journal_dirs:
        entries.extend(list_entries(folder))
    entries.sort(key=lambda item: (item.get("date", ""), item.get("employeeName", ""), item.get("startTime", "")))
    return {
        "ok": True,
        "root": str(normalize_path(root_folder)),
        "journalDirs": [str(path) for path in journal_dirs],
        "entries": entries,
        "count": len(entries),
    }


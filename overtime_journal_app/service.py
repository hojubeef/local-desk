"""File-backed overtime journal and attendance-log service."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import uuid
from pathlib import Path


JOURNAL_DIR_NAME = "야근일지"
ENTRY_VERSION = 2
BACKUP_VERSION = 1
BACKUP_DIR_NAME = "backups"
TRASH_DIR_NAME = "trash"
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
ATTENDANCE_TIMESTAMP_PATTERN = re.compile(r"(20\d{12})\s*$")
ATTENDANCE_NAME_KIND_PATTERN = re.compile(r"(?P<name>[가-힣A-Za-z\s]{2,30})(?P<kind>[12])(?=[A-Za-z0-9])")
ATTENDANCE_TEXT_EXTENSIONS = {".txt", ".csv", ".log"}


class OvertimeError(ValueError):
    """Raised when an overtime request cannot be handled safely."""


def safe_text(value, fallback=""):
    if value is None:
        return fallback
    return str(value)


def normalize_name(value: str) -> str:
    return re.sub(r"\s+", "", safe_text(value).strip())


def compact_folder_name(value) -> str:
    return re.sub(r"[\s._-]+", "", safe_text(value).strip())


def looks_like_journal_root(path) -> bool:
    name = compact_folder_name(Path(path).name)
    return name == JOURNAL_DIR_NAME or "야근" in name or "연장근무" in name


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def normalize_path(value) -> Path:
    text = safe_text(value).strip().strip('"')
    if not text:
        raise OvertimeError("폴더 경로가 필요합니다.")
    return Path(text).expanduser()


def journal_dir(base_folder) -> Path:
    base = normalize_path(base_folder)
    if looks_like_journal_root(base):
        return base
    if (base / "entries").exists() or (base / "settings.json").exists():
        return base
    return base / JOURNAL_DIR_NAME


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


def parse_time_value(value: str) -> dt.time:
    text = safe_text(value).strip()
    if not re.fullmatch(r"\d{2}:\d{2}", text):
        raise OvertimeError(f"시간 형식이 올바르지 않습니다: {text}")
    hour, minute = [int(part) for part in text.split(":")]
    return dt.time(_hour(hour), _minute(minute))


def minutes_between(date_value: str, start_time: str, end_time: str) -> int:
    entry_date = dt.date.fromisoformat(date_value)
    start_dt = dt.datetime.combine(entry_date, parse_time_value(start_time))
    end_dt = dt.datetime.combine(entry_date, parse_time_value(end_time))
    if end_dt <= start_dt:
        end_dt += dt.timedelta(days=1)
    minutes = int((end_dt - start_dt).total_seconds() // 60)
    if minutes <= 0:
        raise OvertimeError("근무 시간이 0분 이하입니다.")
    if minutes > 24 * 60:
        raise OvertimeError("근무 시간이 24시간을 넘습니다.")
    return minutes


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
    start_time = f"{start_hour:02d}:{start_minute:02d}"
    end_time = f"{end_hour:02d}:{end_minute:02d}"
    minutes = minutes_between(entry_date.isoformat(), start_time, end_time)

    return {
        "date": entry_date.isoformat(),
        "weekday": "월화수목금토일"[entry_date.weekday()],
        "startTime": start_time,
        "endTime": end_time,
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
    minutes = int(entry.get("minutes") or minutes_between(entry_date.isoformat(), start_time, end_time))
    if minutes <= 0:
        raise OvertimeError("근무 시간이 0분 이하입니다.")

    name = safe_text(entry.get("employeeName") or employee_name).strip()
    if not name:
        raise OvertimeError("이름을 입력해주세요.")

    created_at = safe_text(entry.get("createdAt")) or now_iso()
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
        "createdAt": created_at,
        "updatedAt": now_iso(),
        "history": entry.get("history") if isinstance(entry.get("history"), list) else [],
    }
    if entry.get("proxyInput") is not None:
        normalized["proxyInput"] = bool(entry.get("proxyInput"))
    if safe_text(entry.get("createdBy")):
        normalized["createdBy"] = safe_text(entry.get("createdBy")).strip()
    if safe_text(entry.get("createdByName")):
        normalized["createdByName"] = safe_text(entry.get("createdByName")).strip()
    if safe_text(entry.get("warning")):
        normalized["warning"] = safe_text(entry.get("warning"))
    return normalized


def entry_filename(entry: dict) -> str:
    return "_".join([
        safe_filename_part(entry["date"]),
        safe_filename_part(entry["startTime"].replace(":", "")),
        safe_filename_part(entry["endTime"].replace(":", "")),
        safe_filename_part(entry["employeeName"]),
        safe_filename_part(entry["id"][-10:]),
    ]) + ".json"


def entry_path(root: Path, entry: dict) -> Path:
    month = safe_text(entry.get("date"))[:7]
    return root / "entries" / month / entry_filename(entry)


def write_entry(root: Path, entry: dict, path: Path | None = None) -> dict:
    path = path or entry_path(root, entry)
    path.parent.mkdir(parents=True, exist_ok=True)
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
    backup = create_user_backup(base_folder, employee_name, "after_save")
    return {
        "ok": True,
        "journalDir": str(root),
        "saved": saved,
        "backup": backup,
        "count": len(saved),
    }


def read_entry(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
        if not isinstance(data, dict):
            return None
        data.setdefault("id", path.stem)
        data.setdefault("history", [])
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


def filter_entries_by_employee(entries: list[dict], employee_name: str = "") -> list[dict]:
    name = normalize_name(employee_name)
    if not name:
        return list(entries)
    return [entry for entry in entries if normalize_name(entry.get("employeeName")) == name]


def backup_file_name(employee_name: str = "", scope: str = "user") -> str:
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    name = safe_filename_part(normalize_name(employee_name), "all")
    suffix = uuid.uuid4().hex[:6]
    return f"{scope}_backup_{name}_{stamp}_{suffix}.json"


def backup_payload(entries: list[dict], employee_name: str = "", reason: str = "manual", scope: str = "user") -> dict:
    filtered_entries = filter_entries_by_employee(entries, employee_name)
    return {
        "kind": "overtime-journal-backup",
        "version": BACKUP_VERSION,
        "scope": scope,
        "reason": safe_text(reason) or "manual",
        "employeeName": safe_text(employee_name).strip(),
        "createdAt": now_iso(),
        "entryCount": len(filtered_entries),
        "entries": filtered_entries,
    }


def write_backup_snapshot(
    target_dir: Path,
    entries: list[dict],
    employee_name: str = "",
    reason: str = "manual",
    scope: str = "user",
    write_latest: bool = False,
) -> dict:
    target_dir.mkdir(parents=True, exist_ok=True)
    payload = backup_payload(entries, employee_name, reason, scope)
    path = target_dir / backup_file_name(employee_name, scope)
    with path.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
    if write_latest:
        latest_path = target_dir / "latest.json"
        with latest_path.open("w", encoding="utf-8", newline="\n") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
            file.write("\n")
    return {
        "ok": True,
        "path": str(path),
        "count": payload["entryCount"],
        "employeeName": payload["employeeName"],
        "createdAt": payload["createdAt"],
    }


def create_user_backup(base_folder, employee_name: str = "", reason: str = "manual") -> dict:
    root = ensure_journal(base_folder)
    entries = list_entries(root)
    return write_backup_snapshot(root / BACKUP_DIR_NAME, entries, employee_name, reason, "user", True)


def read_backup_payload(backup_path) -> dict:
    path = normalize_path(backup_path)
    if not path.exists() or not path.is_file():
        raise OvertimeError("백업 파일을 찾을 수 없습니다.")
    try:
        with path.open("r", encoding="utf-8") as file:
            data = json.load(file)
    except Exception as error:
        raise OvertimeError(f"백업 파일을 읽을 수 없습니다: {error}") from error
    if not isinstance(data, dict) or data.get("kind") != "overtime-journal-backup":
        raise OvertimeError("야근일지 백업 파일이 아닙니다.")
    entries = data.get("entries")
    if not isinstance(entries, list):
        raise OvertimeError("백업 파일 안에 기록 목록이 없습니다.")
    return data


def restore_backup_to_folder(base_folder, backup_path, employee_name: str = "") -> dict:
    backup = read_backup_payload(backup_path)
    root = ensure_journal(base_folder)
    entries = filter_entries_by_employee(backup.get("entries") or [], employee_name)
    existing_ids = {safe_text(entry.get("id")) for entry in list_entries(root)}
    restored = []
    skipped = []
    errors = []
    for entry in entries:
        entry_id_value = safe_text(entry.get("id"))
        if entry_id_value and entry_id_value in existing_ids:
            skipped.append({"id": entry_id_value, "reason": "already_exists"})
            continue
        try:
            normalized = validate_entry(entry, entry.get("employeeName") or employee_name)
            saved = write_entry(root, normalized)
            restored.append(saved)
            existing_ids.add(safe_text(saved.get("id")))
        except Exception as error:
            errors.append({"id": entry_id_value, "message": str(error)})
    create_user_backup(base_folder, employee_name, "after_restore")
    return {
        "ok": True,
        "backupPath": str(normalize_path(backup_path)),
        "restored": restored,
        "restoredCount": len(restored),
        "skippedCount": len(skipped),
        "errorCount": len(errors),
        "skipped": skipped,
        "errors": errors,
    }


def restore_backup_to_original_paths(backup_path, employee_name: str = "") -> dict:
    backup = read_backup_payload(backup_path)
    entries = filter_entries_by_employee(backup.get("entries") or [], employee_name)
    restored = []
    skipped = []
    errors = []
    for entry in entries:
        target_text = safe_text(entry.get("path")).strip()
        if not target_text:
            skipped.append({"id": safe_text(entry.get("id")), "reason": "missing_original_path"})
            continue
        target = Path(target_text)
        if target.exists():
            skipped.append({"id": safe_text(entry.get("id")), "path": str(target), "reason": "already_exists"})
            continue
        try:
            normalized = validate_entry(entry, entry.get("employeeName") or employee_name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("w", encoding="utf-8", newline="\n") as file:
                json.dump(normalized, file, ensure_ascii=False, indent=2)
                file.write("\n")
            restored.append({"id": normalized.get("id"), "path": str(target)})
        except Exception as error:
            errors.append({"id": safe_text(entry.get("id")), "path": str(target), "message": str(error)})
    return {
        "ok": True,
        "backupPath": str(normalize_path(backup_path)),
        "restoredCount": len(restored),
        "skippedCount": len(skipped),
        "errorCount": len(errors),
        "restored": restored,
        "skipped": skipped,
        "errors": errors,
    }


def find_entry_path(base_folder, entry_id_value: str) -> tuple[Path, dict]:
    root = journal_dir(base_folder)
    entry_id_value = safe_text(entry_id_value).strip()
    if not entry_id_value:
        raise OvertimeError("항목 ID가 필요합니다.")
    entries_root = root / "entries"
    if not entries_root.exists():
        raise OvertimeError("야근일지 폴더를 찾지 못했습니다.")
    for path in entries_root.rglob("*.json"):
        entry = read_entry(path)
        if entry and safe_text(entry.get("id")) == entry_id_value:
            return path, entry
    raise OvertimeError("야근일지를 찾지 못했습니다.")


def update_entry(base_folder, entry_id_value: str, updates: dict, employee_name: str = "") -> dict:
    root = ensure_journal(base_folder)
    old_path, old_entry = find_entry_path(base_folder, entry_id_value)
    backup = create_user_backup(base_folder, employee_name or old_entry.get("employeeName", ""), "before_update")
    merged = dict(old_entry)
    for key in ("employeeName", "date", "startTime", "endTime", "work", "sourceText"):
        if key in updates:
            merged[key] = updates[key]
    merged["id"] = old_entry.get("id")
    merged["createdAt"] = old_entry.get("createdAt")
    merged["history"] = old_entry.get("history") if isinstance(old_entry.get("history"), list) else []
    merged["minutes"] = minutes_between(safe_text(merged.get("date")), safe_text(merged.get("startTime")), safe_text(merged.get("endTime")))
    normalized = validate_entry(merged, employee_name or old_entry.get("employeeName", ""))

    tracked_fields = ("employeeName", "date", "startTime", "endTime", "minutes", "work")
    previous = {field: old_entry.get(field) for field in tracked_fields}
    current = {field: normalized.get(field) for field in tracked_fields}
    if previous != current:
        normalized["history"] = [
            *normalized.get("history", []),
            {
                "editedAt": now_iso(),
                "previous": previous,
                "current": current,
            },
        ]
    new_path = entry_path(root, normalized)
    saved = write_entry(root, normalized, new_path)
    if old_path.resolve() != new_path.resolve():
        old_path.unlink(missing_ok=True)
    return {
        "ok": True,
        "entry": saved,
        "edited": previous != current,
        "backup": backup,
    }


def delete_entry(base_folder, entry_id_value: str) -> dict:
    path, entry = find_entry_path(base_folder, entry_id_value)
    backup = create_user_backup(base_folder, entry.get("employeeName", ""), "before_delete")
    path.unlink()
    return {"ok": True, "deleted": entry_id_value, "backup": backup}


def path_is_inside(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (OSError, ValueError):
        return False


def trash_file_path(root: Path, original_path: Path, entry: dict) -> Path:
    month = safe_text(entry.get("date"))[:7] or dt.datetime.now().strftime("%Y-%m")
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{safe_filename_part(original_path.stem, 'entry')}_{stamp}_{uuid.uuid4().hex[:6]}.json"
    return root / TRASH_DIR_NAME / month / filename


def write_trash_item(target: Path, original_path: Path, entry: dict, deleted_by: str = "") -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "kind": "overtime-journal-trash",
        "version": 1,
        "deletedAt": now_iso(),
        "deletedBy": safe_text(deleted_by).strip(),
        "originalPath": str(original_path),
        "entry": entry,
    }
    with target.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
        file.write("\n")
    return trash_payload_to_item(payload, target)


def read_trash_payload(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as file:
            payload = json.load(file)
    except Exception:
        return None
    if not isinstance(payload, dict) or payload.get("kind") != "overtime-journal-trash":
        return None
    if not isinstance(payload.get("entry"), dict):
        return None
    return payload


def trash_payload_to_item(payload: dict, path: Path) -> dict:
    entry = dict(payload.get("entry") or {})
    entry["trashPath"] = str(path)
    entry["originalPath"] = safe_text(payload.get("originalPath"))
    entry["deletedAt"] = safe_text(payload.get("deletedAt"))
    entry["deletedBy"] = safe_text(payload.get("deletedBy"))
    entry["journalDir"] = str(path.parents[2]) if len(path.parents) >= 3 else ""
    return entry


def list_trash_entries(base_folder, employee_name: str = "") -> list[dict]:
    root = journal_dir(base_folder)
    trash_root = root / TRASH_DIR_NAME
    if not trash_root.exists():
        return []
    items = []
    for path in trash_root.rglob("*.json"):
        payload = read_trash_payload(path)
        if payload:
            items.append(trash_payload_to_item(payload, path))
    items = filter_entries_by_employee(items, employee_name)
    return sorted(items, key=lambda item: (item.get("deletedAt", ""), item.get("date", "")), reverse=True)


def find_trash_item(base_folder, trash_key: str) -> tuple[Path, dict]:
    root = journal_dir(base_folder)
    trash_root = root / TRASH_DIR_NAME
    key = safe_text(trash_key).strip()
    if not key:
        raise OvertimeError("휴지통 항목이 필요합니다.")
    candidates = []
    key_path = Path(key)
    if key_path.is_absolute():
        candidates.append(key_path)
    if trash_root.exists():
        candidates.extend(trash_root.rglob("*.json"))
    for path in candidates:
        if not path.exists() or not path_is_inside(path, trash_root):
            continue
        payload = read_trash_payload(path)
        if not payload:
            continue
        entry = payload.get("entry") or {}
        if str(path) == key or safe_text(entry.get("id")) == key:
            return path, payload
    raise OvertimeError("휴지통 항목을 찾지 못했습니다.")


def move_entry_to_trash(base_folder, entry_id_value: str, deleted_by: str = "") -> dict:
    root = ensure_journal(base_folder)
    old_path, entry = find_entry_path(base_folder, entry_id_value)
    backup = create_user_backup(base_folder, entry.get("employeeName", ""), "before_trash")
    trash_path = trash_file_path(root, old_path, entry)
    trash_item = write_trash_item(trash_path, old_path, entry, deleted_by)
    old_path.unlink()
    return {
        "ok": True,
        "deleted": entry_id_value,
        "trashItem": trash_item,
        "backup": backup,
    }


def restore_trash_entry(base_folder, trash_key: str) -> dict:
    root = ensure_journal(base_folder)
    trash_path, payload = find_trash_item(base_folder, trash_key)
    entry = payload.get("entry") or {}
    normalized = validate_entry(entry, entry.get("employeeName", ""))
    original_text = safe_text(payload.get("originalPath")).strip()
    target = Path(original_text) if original_text else entry_path(root, normalized)
    if not path_is_inside(target, root):
        target = entry_path(root, normalized)
    if target.exists():
        raise OvertimeError("같은 위치에 이미 기록 파일이 있습니다.")
    target.parent.mkdir(parents=True, exist_ok=True)
    saved = write_entry(root, normalized, target)
    trash_path.unlink()
    backup = create_user_backup(root, normalized.get("employeeName", ""), "after_trash_restore")
    return {"ok": True, "entry": saved, "trashPath": str(trash_path), "backup": backup}


def purge_trash_entry(base_folder, trash_key: str) -> dict:
    trash_path, payload = find_trash_item(base_folder, trash_key)
    entry = payload.get("entry") or {}
    trash_path.unlink()
    return {
        "ok": True,
        "purged": safe_text(entry.get("id")),
        "trashPath": str(trash_path),
    }


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
        if looks_like_journal_root(folder):
            candidates.append(folder)
        if (folder / JOURNAL_DIR_NAME / "entries").exists():
            candidates.append(folder / JOURNAL_DIR_NAME)
        if (folder / "entries").exists() and (looks_like_journal_root(folder) or (folder / "settings.json").exists()):
            candidates.append(folder)
        if (folder / TRASH_DIR_NAME).exists() and (looks_like_journal_root(folder) or (folder / "settings.json").exists()):
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


def decode_text_file(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "cp949", "euc-kr", "utf-8"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def parse_attendance_line(line: str, source_path: Path | None = None) -> dict | None:
    text = line.strip()
    if not text:
        return None
    timestamp_match = ATTENDANCE_TIMESTAMP_PATTERN.search(text)
    if not timestamp_match:
        return None
    timestamp = timestamp_match.group(1)
    try:
        stamped_at = dt.datetime.strptime(timestamp, "%Y%m%d%H%M%S")
    except ValueError:
        return None

    prefix = text[:timestamp_match.start()]
    matches = list(ATTENDANCE_NAME_KIND_PATTERN.finditer(prefix))
    if not matches:
        return None
    match = matches[-1]
    kind = match.group("kind")
    name = normalize_name(match.group("name"))
    if not name:
        return None
    return {
        "employeeName": name,
        "kind": kind,
        "kindLabel": "출근" if kind == "1" else "퇴근",
        "date": stamped_at.date().isoformat(),
        "time": stamped_at.strftime("%H:%M:%S"),
        "timestamp": stamped_at.strftime("%Y-%m-%dT%H:%M:%S"),
        "sourcePath": str(source_path) if source_path else "",
        "raw": text,
    }


def attendance_files(folders: list[str]) -> list[Path]:
    files = []
    seen = set()
    for folder in folders:
        if not safe_text(folder).strip():
            continue
        path = normalize_path(folder)
        if path.is_file():
            candidates = [path]
        elif path.exists():
            candidates = [
                candidate
                for candidate in path.rglob("*")
                if candidate.is_file() and candidate.suffix.lower() in ATTENDANCE_TEXT_EXTENSIONS
            ]
        else:
            continue
        for candidate in candidates:
            key = str(candidate.resolve())
            if key not in seen:
                seen.add(key)
                files.append(candidate)
    return sorted(files)


def collect_attendance(folders: list[str]) -> dict:
    records = {}
    parsed_count = 0
    warnings = []
    for path in attendance_files(folders):
        try:
            text = decode_text_file(path)
        except Exception as error:
            warnings.append({"path": str(path), "message": str(error)})
            continue
        for line in text.splitlines():
            parsed = parse_attendance_line(line, path)
            if not parsed:
                continue
            parsed_count += 1
            key = (parsed["employeeName"], parsed["date"])
            if key not in records:
                records[key] = {
                    "employeeName": parsed["employeeName"],
                    "date": parsed["date"],
                    "checkIns": [],
                    "checkOuts": [],
                    "sourcePaths": set(),
                }
            bucket = records[key]
            bucket["sourcePaths"].add(parsed["sourcePath"])
            if parsed["kind"] == "1":
                bucket["checkIns"].append(parsed)
            elif parsed["kind"] == "2":
                bucket["checkOuts"].append(parsed)

    normalized = []
    for bucket in records.values():
        check_ins = sorted(bucket["checkIns"], key=lambda item: item["timestamp"])
        check_outs = sorted(bucket["checkOuts"], key=lambda item: item["timestamp"])
        normalized.append({
            "employeeName": bucket["employeeName"],
            "date": bucket["date"],
            "firstCheckIn": check_ins[0] if check_ins else None,
            "lastCheckOut": check_outs[-1] if check_outs else None,
            "checkInCount": len(check_ins),
            "checkOutCount": len(check_outs),
            "sourcePaths": sorted(bucket["sourcePaths"]),
        })
    normalized.sort(key=lambda item: (item["date"], item["employeeName"]))
    return {
        "ok": True,
        "records": normalized,
        "parsedCount": parsed_count,
        "warnings": warnings,
    }


def time_to_minutes(value: str) -> int:
    hour, minute = [int(part) for part in safe_text(value)[:5].split(":")]
    return hour * 60 + minute


def minutes_to_time(value: int) -> str:
    value = value % (24 * 60)
    return f"{value // 60:02d}:{value % 60:02d}"


def round_time(value: str, interval: int = 5) -> str:
    interval = max(1, int(interval or 5))
    hour, minute, *_rest = [int(part) for part in safe_text(value).split(":")]
    total = hour * 60 + minute
    remainder = total % interval
    if remainder * 2 >= interval:
        total += interval - remainder
    else:
        total -= remainder
    return minutes_to_time(total)


def report_options(options: dict | None = None) -> dict:
    options = options or {}
    return {
        "lateThreshold": safe_text(options.get("lateThreshold") or "18:30"),
        "overtimeStart": safe_text(options.get("overtimeStart") or "18:00"),
        "roundingMinutes": int(options.get("roundingMinutes") or 5),
        "ignoreMissingCheckIn": bool(options.get("ignoreMissingCheckIn", True)),
        "ignoreMissingCheckOut": bool(options.get("ignoreMissingCheckOut", True)),
    }


def entry_date_map(entries: list[dict]) -> dict[str, set[str]]:
    result = {}
    for entry in entries:
        name = normalize_name(entry.get("employeeName"))
        date_value = safe_text(entry.get("date"))
        if not name or not date_value:
            continue
        result.setdefault(name, set()).add(date_value)
    return result


def suggestion_text(issue: dict, options: dict) -> str:
    date_value = issue["date"]
    entry_date = dt.date.fromisoformat(date_value)
    display_date = f"{entry_date.year}.{entry_date.month:02d}.{entry_date.day:02d}({issue.get('weekday') or '월화수목금토일'[entry_date.weekday()]})"
    end_time = issue.get("roundedCheckOut") or issue.get("checkOutTime") or options["lateThreshold"]
    return f"{display_date} {options['overtimeStart']}~{end_time}\n"


def build_attendance_report(
    attendance_folders: list[str],
    overtime_entries: list[dict],
    options: dict | None = None,
    employee_name: str = "",
    today: dt.date | None = None,
) -> dict:
    options = report_options(options)
    attendance = collect_attendance(attendance_folders)
    entries_by_name = entry_date_map(overtime_entries)
    employee_filter = normalize_name(employee_name)
    threshold_minutes = time_to_minutes(options["lateThreshold"])
    issues = []
    records = []

    for record in attendance["records"]:
        name = normalize_name(record["employeeName"])
        if employee_filter and name != employee_filter:
            continue
        date_value = record["date"]
        has_entry = date_value in entries_by_name.get(name, set())
        check_in = record.get("firstCheckIn")
        check_out = record.get("lastCheckOut")
        check_out_time = check_out["time"] if check_out else ""
        rounded_check_out = round_time(check_out_time, options["roundingMinutes"]) if check_out_time else ""
        status = "ok"
        reason = ""
        needs_action = False

        if check_out:
            if time_to_minutes(rounded_check_out) >= threshold_minutes and not has_entry:
                status = "late_no_journal"
                reason = "퇴근 기록은 늦지만 야근일지가 없습니다."
                needs_action = True
        elif check_in and not options["ignoreMissingCheckOut"]:
            status = "missing_checkout"
            reason = "출근 기록은 있지만 퇴근 기록이 없습니다."
            needs_action = True

        if check_out and not check_in and not options["ignoreMissingCheckIn"]:
            status = "missing_checkin" if status == "ok" else status
            reason = reason or "퇴근 기록은 있지만 출근 기록이 없습니다."
            needs_action = True

        normalized_record = {
            "employeeName": record["employeeName"],
            "date": date_value,
            "weekday": "월화수목금토일"[dt.date.fromisoformat(date_value).weekday()],
            "firstCheckIn": check_in["time"] if check_in else "",
            "lastCheckOut": check_out_time,
            "roundedCheckOut": rounded_check_out,
            "checkInCount": record["checkInCount"],
            "checkOutCount": record["checkOutCount"],
            "hasJournal": has_entry,
            "status": status,
            "reason": reason,
            "needsAction": needs_action,
            "sourcePaths": record["sourcePaths"],
        }
        records.append(normalized_record)
        if needs_action:
            issue = dict(normalized_record)
            issue["suggestionText"] = suggestion_text(issue, options)
            issues.append(issue)

    today = today or dt.date.today()
    yesterday = today - dt.timedelta(days=1)
    suggestions = [
        issue for issue in issues
        if employee_filter and normalize_name(issue["employeeName"]) == employee_filter and issue["date"] == yesterday.isoformat()
    ]
    return {
        "ok": True,
        "options": options,
        "records": records,
        "issues": issues,
        "suggestions": suggestions,
        "warnings": attendance["warnings"],
        "parsedCount": attendance["parsedCount"],
    }

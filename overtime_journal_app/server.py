"""Standalone server for the overtime journal app."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from service import (  # noqa: E402
    OvertimeError,
    build_attendance_report,
    collect_entries,
    create_user_backup,
    delete_entry,
    filter_entries_by_employee,
    journal_dir,
    list_entries,
    list_trash_entries,
    move_entry_to_trash,
    normalize_name,
    parse_entries,
    purge_trash_entry,
    restore_backup_to_folder,
    restore_backup_to_original_paths,
    restore_trash_entry,
    save_entries,
    update_entry,
    write_backup_snapshot,
)


APP_VERSION = "2026.05.07"
APP_NAME = "OvertimeJournal"
APP_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
WEB_DIR = APP_DIR / "web"
SETTINGS_DIR = Path(os.getenv("APPDATA") or Path.home()) / APP_NAME
SETTINGS_PATH = SETTINGS_DIR / "settings.json"
STARTUP_SCRIPT_NAME = "야근일지 자동실행.vbs"
APPROVAL_STATUS_FILE = "approval_status.json"
EMPLOYEE_RANKS = ["전무", "상무", "이사", "차장", "과장", "대리", "사원"]
EMPLOYEE_PATH_NAME_PATTERN = re.compile(r"(?:^\d+\)?\s*)?([가-힣]{2,4})(?![가-힣])")
EMPLOYEE_PATH_SKIP_WORDS = ("야근", "연장근무", "근무", "일지", "backup", "backups", "entries", "trash")


def app_log(message):
    if getattr(sys, "stdout", None):
        print(message, flush=True)


def read_json_file(path: Path, fallback):
    try:
      with path.open("r", encoding="utf-8") as file:
          return json.load(file)
    except Exception:
      return fallback


def write_json_file(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")
    with temp_path.open("w", encoding="utf-8", newline="\n") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
        file.write("\n")
    temp_path.replace(path)


def startup_folder() -> Path:
    appdata = os.getenv("APPDATA")
    if not appdata:
        raise OvertimeError("Windows 시작프로그램 폴더를 찾을 수 없습니다.")
    return Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def startup_script_path() -> Path:
    return startup_folder() / STARTUP_SCRIPT_NAME


def is_startup_enabled() -> bool:
    try:
        return startup_script_path().exists()
    except Exception:
        return False


def startup_command() -> str:
    if getattr(sys, "frozen", False):
        parts = [str(Path(sys.executable))]
    else:
        parts = [str(Path(sys.executable)), str(Path(__file__).resolve())]
    return " ".join(f'"{part}"' for part in parts)


def vbs_string(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def sync_startup(enabled: bool) -> None:
    path = startup_script_path()
    if enabled:
        path.parent.mkdir(parents=True, exist_ok=True)
        command = startup_command()
        content = (
            'Set shell = CreateObject("WScript.Shell")\r\n'
            f"shell.Run {vbs_string(command)}, 0, False\r\n"
        )
        path.write_text(content, encoding="utf-16", newline="\r\n")
        return
    path.unlink(missing_ok=True)


def normalize_name_list(values):
    result = []
    seen = set()
    for value in values or []:
        text = str(value or "").strip()
        key = normalize_name(text)
        if not text or not key or key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def data_root_employees(data_root):
    root_text = str(data_root or "").strip()
    if not root_text:
        return []
    root = Path(root_text)
    if not root.exists() or not root.is_dir():
        return []
    employees = []
    try:
        children = [Path(child.path) for child in os.scandir(root) if child.is_dir()]
    except OSError:
        return []
    for folder in sorted(children, key=lambda item: item.name):
        name = folder.name.strip()
        if not name:
            continue
        employees.append({
            "employeeName": name,
            "folder": str(folder),
            "journalDir": str(journal_dir(folder)),
        })
    return employees


def normalize_employee_ranks(values):
    if not isinstance(values, dict):
        return {}
    ranks = {}
    for raw_name, raw_rank in values.items():
        name = str(raw_name or "").strip()
        rank = str(raw_rank or "").strip()
        if name and rank in EMPLOYEE_RANKS:
            ranks[name] = rank
    return ranks


def normalize_settings(data=None):
    data = data or {}
    data_root = str(data.get("dataRoot") or "").strip()
    employee_name = str(data.get("employeeName") or "").strip()
    root_employees = data_root_employees(data_root)
    employee_ranks = normalize_employee_ranks(data.get("employeeRanks"))
    for employee in root_employees:
        employee["rank"] = employee_ranks.get(employee["employeeName"], "")
    root_names = [item["employeeName"] for item in root_employees]
    selected_employees = data.get("selectedEmployees")
    if not isinstance(selected_employees, list):
        selected_employees = []
    selected_employees = normalize_name_list(selected_employees)
    if data_root and not selected_employees:
        selected_employees = list(root_names)
    if data_root and employee_name and employee_name not in root_names and employee_name not in selected_employees:
        selected_employees.append(employee_name)

    collect_folders = data.get("collectFolders")
    if collect_folders is None and data.get("adminRoot"):
        collect_folders = [data.get("adminRoot")]
    if not isinstance(collect_folders, list):
        collect_folders = []
    if data_root and selected_employees:
        collect_folders = [str(Path(data_root) / name) for name in selected_employees]
    attendance_folders = data.get("attendanceFolders")
    if not isinstance(attendance_folders, list):
        attendance_folders = []

    seen = set()
    normalized_collect_folders = []
    for folder in collect_folders:
        value = str(folder or "").strip()
        if not value or value.lower() in seen:
            continue
        seen.add(value.lower())
        normalized_collect_folders.append(value)

    seen = set()
    normalized_attendance_folders = []
    for folder in attendance_folders:
        value = str(folder or "").strip()
        if not value or value.lower() in seen:
            continue
        seen.add(value.lower())
        normalized_attendance_folders.append(value)

    base_folder = str(data.get("baseFolder") or "").strip()
    if data_root and employee_name:
        base_folder = str(Path(data_root) / employee_name)
    startup_enabled = data.get("startupEnabled")
    if startup_enabled is None:
        startup_enabled = is_startup_enabled()
    theme = str(data.get("theme") or "dark").strip().lower()
    if theme not in {"dark", "light"}:
        theme = "dark"
    return {
        "employeeName": employee_name,
        "dataRoot": data_root,
        "baseFolder": base_folder,
        "journalDir": str(journal_dir(base_folder)) if base_folder else "",
        "dataRootEmployees": root_employees,
        "selectedEmployees": selected_employees,
        "employeeRanks": employee_ranks,
        "rankOptions": EMPLOYEE_RANKS,
        "collectFolders": normalized_collect_folders,
        "attendanceFolders": normalized_attendance_folders,
        "lateThreshold": str(data.get("lateThreshold") or "18:30"),
        "overtimeStart": str(data.get("overtimeStart") or "18:00"),
        "nightHourlyWage": int(float(data.get("nightHourlyWage") or 0)),
        "roundingMinutes": int(data.get("roundingMinutes") or 5),
        "hideOldIssues": bool(data.get("hideOldIssues", True)),
        "startupEnabled": bool(startup_enabled),
        "startupScript": str(startup_script_path()) if os.getenv("APPDATA") else "",
        "ignoreMissingCheckIn": bool(data.get("ignoreMissingCheckIn", True)),
        "ignoreMissingCheckOut": bool(data.get("ignoreMissingCheckOut", True)),
        "theme": theme,
        "proxyFeatureEnabled": bool(data.get("proxyFeatureEnabled", False)),
        "adminFeatureEnabled": bool(data.get("adminFeatureEnabled", False)),
        "updatedAt": str(data.get("updatedAt") or ""),
    }


def load_settings():
    return normalize_settings(read_json_file(SETTINGS_PATH, {}))


def save_settings(data):
    payload = normalize_settings(data)
    sync_startup(payload["startupEnabled"])
    payload["startupEnabled"] = is_startup_enabled()
    write_json_file(SETTINGS_PATH, payload)
    if payload["baseFolder"]:
        journal_dir(payload["baseFolder"]).mkdir(parents=True, exist_ok=True)
        (journal_dir(payload["baseFolder"]) / "entries").mkdir(parents=True, exist_ok=True)
    return load_settings()


def choose_folder(initial_dir="", title="폴더 선택"):
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:OTJ_DIALOG_TITLE
$dialog.ShowNewFolderButton = $true
if ($env:OTJ_INITIAL_DIR -and (Test-Path -LiteralPath $env:OTJ_INITIAL_DIR)) {
    $dialog.SelectedPath = $env:OTJ_INITIAL_DIR
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = "CenterScreen"
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.SelectedPath
}
$owner.Close()
$owner.Dispose()
"""
    env = os.environ.copy()
    env["OTJ_DIALOG_TITLE"] = str(title or "폴더 선택")
    env["OTJ_INITIAL_DIR"] = str(initial_dir or "")
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        if completed.returncode == 0:
            return completed.stdout.strip()
    except Exception:
        pass

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        options = {"title": title}
        if initial_dir and Path(initial_dir).exists():
            options["initialdir"] = initial_dir
        selected = filedialog.askdirectory(**options)
        root.destroy()
        return selected or ""
    except Exception as error:
        raise OvertimeError(f"폴더 선택 창을 열 수 없습니다: {error}") from error


def choose_file(initial_dir="", title="백업 파일 선택"):
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:OTJ_DIALOG_TITLE
$dialog.Filter = "JSON backup (*.json)|*.json|All files (*.*)|*.*"
$dialog.Multiselect = $false
if ($env:OTJ_INITIAL_DIR -and (Test-Path -LiteralPath $env:OTJ_INITIAL_DIR)) {
    $candidate = Get-Item -LiteralPath $env:OTJ_INITIAL_DIR
    if ($candidate.PSIsContainer) {
        $dialog.InitialDirectory = $candidate.FullName
    } else {
        $dialog.InitialDirectory = $candidate.DirectoryName
        $dialog.FileName = $candidate.Name
    }
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = "CenterScreen"
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $dialog.FileName
}
$owner.Close()
$owner.Dispose()
"""
    env = os.environ.copy()
    env["OTJ_DIALOG_TITLE"] = str(title or "백업 파일 선택")
    env["OTJ_INITIAL_DIR"] = str(initial_dir or "")
    try:
        completed = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        if completed.returncode == 0:
            return completed.stdout.strip()
    except Exception:
        pass

    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        options = {
            "title": title,
            "filetypes": [("JSON backup", "*.json"), ("All files", "*.*")],
        }
        if initial_dir and Path(initial_dir).exists():
            path = Path(initial_dir)
            options["initialdir"] = str(path if path.is_dir() else path.parent)
        selected = filedialog.askopenfilename(**options)
        root.destroy()
        return selected or ""
    except Exception as error:
        raise OvertimeError(f"백업 파일 선택 창을 열 수 없습니다: {error}") from error


def aggregate_collected(roots):
    if not isinstance(roots, list):
        roots = [roots] if roots else []
    entries = []
    journal_dirs = []
    warnings = []
    seen = set()

    for root in roots:
        root = str(root or "").strip()
        if not root:
            continue
        try:
            payload = collect_entries(root)
        except Exception as error:
            warnings.append({"root": root, "message": str(error)})
            continue
        journal_dirs.extend(payload.get("journalDirs") or [])
        for entry in payload.get("entries") or []:
            entry_root = entry_journal_root(entry)
            if entry_root:
                entry["journalDir"] = str(entry_root)
            key = entry.get("path") or entry.get("id")
            if key in seen:
                continue
            seen.add(key)
            entries.append(entry)

    entries.sort(key=lambda item: (
        str(item.get("date") or ""),
        str(item.get("employeeName") or ""),
        str(item.get("startTime") or ""),
    ))
    decorate_entries_with_approval(entries)
    return {
        "ok": True,
        "roots": [str(root) for root in roots if str(root or "").strip()],
        "journalDirs": journal_dirs,
        "entries": entries,
        "count": len(entries),
        "warnings": warnings,
    }


def aggregate_trash(roots, employee_name=""):
    if not isinstance(roots, list):
        roots = [roots] if roots else []
    items = []
    warnings = []
    seen = set()

    for root in roots:
        root = str(root or "").strip()
        if not root:
            continue
        try:
            payload = collect_entries(root)
        except Exception as error:
            warnings.append({"root": root, "message": str(error)})
            continue
        for folder in payload.get("journalDirs") or []:
            try:
                for item in list_trash_entries(folder, employee_name):
                    key = item.get("trashPath") or item.get("id")
                    if key in seen:
                        continue
                    seen.add(key)
                    if not item.get("journalDir"):
                        item["journalDir"] = str(journal_dir(folder))
                    items.append(item)
            except Exception as error:
                warnings.append({"root": str(folder), "message": str(error)})

    items.sort(key=lambda item: (
        str(item.get("deletedAt") or ""),
        str(item.get("date") or ""),
        str(item.get("employeeName") or ""),
    ), reverse=True)
    return {
        "ok": True,
        "roots": [str(root) for root in roots if str(root or "").strip()],
        "items": items,
        "count": len(items),
        "warnings": warnings,
    }


def create_admin_backup(collect_folders, employee_name=""):
    payload = aggregate_collected(collect_folders)
    entries = payload.get("entries") or []
    backup = write_backup_snapshot(
        SETTINGS_DIR / "admin_backups",
        entries,
        employee_name,
        "admin_manual",
        "admin",
        False,
    )
    backup["availableCount"] = len(filter_entries_by_employee(entries, employee_name))
    backup["warnings"] = payload.get("warnings") or []
    return backup


def now_local_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def entry_journal_root(entry):
    text = str(entry.get("path") or "").strip()
    if not text:
        return None
    path = Path(text)
    for parent in path.parents:
        if parent.name == "entries":
            return parent.parent
    return None


def approval_status_path(root: Path) -> Path:
    return root / APPROVAL_STATUS_FILE


def read_approval_status(root: Path) -> dict:
    path = approval_status_path(root)
    data = read_json_file(path, {})
    if not isinstance(data, dict):
        data = {}
    items = data.get("items")
    if not isinstance(items, dict):
        items = {}
    return {
        "version": 1,
        "updatedAt": str(data.get("updatedAt") or ""),
        "items": items,
    }


def write_approval_status(root: Path, data: dict):
    payload = {
        "version": 1,
        "updatedAt": now_local_iso(),
        "items": data.get("items") if isinstance(data.get("items"), dict) else {},
    }
    write_json_file(approval_status_path(root), payload)


def approval_label(status):
    labels = {
        "submitted": "결재 올림",
        "approved": "결재 완료",
        "time_mismatch": "시간 상이",
        "approval_missing": "결재 누락",
    }
    return labels.get(str(status or ""), "")


def decorate_entries_with_approval(entries):
    cache = {}
    for entry in entries:
        root = entry_journal_root(entry)
        if not root:
            continue
        key = str(root)
        if key not in cache:
            cache[key] = read_approval_status(root)
        item = cache[key]["items"].get(str(entry.get("id") or ""))
        if item:
            entry["approval"] = item
            entry["approvalStatus"] = item.get("status") or ""
            entry["approvalLabel"] = approval_label(item.get("status"))
        else:
            entry["approval"] = {}
            entry["approvalStatus"] = ""
            entry["approvalLabel"] = ""
    return entries


def set_approval_for_entries(entries, status, note="", approval_record=None):
    grouped = {}
    for entry in entries:
        entry_id = str(entry.get("id") or "").strip()
        root = entry_journal_root(entry)
        if not entry_id or not root:
            continue
        grouped.setdefault(str(root), {"root": root, "entries": []})["entries"].append(entry)

    updated = 0
    for bucket in grouped.values():
        root = bucket["root"]
        payload = read_approval_status(root)
        items = payload["items"]
        for entry in bucket["entries"]:
            entry_id = str(entry.get("id") or "")
            previous = items.get(entry_id) if isinstance(items.get(entry_id), dict) else {}
            items[entry_id] = {
                **previous,
                "id": entry_id,
                "employeeName": entry.get("employeeName") or "",
                "date": entry.get("date") or "",
                "startTime": entry.get("startTime") or "",
                "endTime": entry.get("endTime") or "",
                "minutes": entry.get("minutes") or 0,
                "status": status,
                "label": approval_label(status),
                "note": note,
                "updatedAt": now_local_iso(),
            }
            if status == "submitted" and not previous.get("submittedAt"):
                items[entry_id]["submittedAt"] = now_local_iso()
            if status == "approved":
                items[entry_id]["approvedAt"] = now_local_iso()
            if approval_record:
                items[entry_id]["approvalRecord"] = approval_record
            updated += 1
        payload["items"] = items
        write_approval_status(root, payload)
    return updated


def clear_approval_for_entries(entries):
    grouped = {}
    for entry in entries:
        entry_id = str(entry.get("id") or "").strip()
        root = entry_journal_root(entry)
        if not entry_id or not root:
            continue
        grouped.setdefault(str(root), {"root": root, "ids": []})["ids"].append(entry_id)

    updated = 0
    for bucket in grouped.values():
        root = bucket["root"]
        payload = read_approval_status(root)
        items = payload["items"]
        for entry_id in bucket["ids"]:
            item = items.get(entry_id)
            if isinstance(item, dict) and item.get("status") == "submitted":
                items.pop(entry_id, None)
                updated += 1
        payload["items"] = items
        write_approval_status(root, payload)
    return updated


def minutes_from_time_range(start_time, end_time):
    try:
        start_hour, start_minute = [int(part) for part in str(start_time)[:5].split(":")]
        end_hour, end_minute = [int(part) for part in str(end_time)[:5].split(":")]
    except Exception:
        return 0
    start = start_hour * 60 + start_minute
    end = end_hour * 60 + end_minute
    if end <= start:
        end += 24 * 60
    return end - start


def parse_approval_lines(text):
    records = []
    errors = []
    pattern = re.compile(
        r"^\s*(?P<name>\S+)\s+"
        r"(?P<date>20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2})\s+"
        r"(?P<start>\d{1,2}:\d{2})\s*~\s*"
        r"(?P<end>\d{1,2}:\d{2})"
        r"(?:\s+(?P<duration>\d{1,3}:\d{2}))?\s*$"
    )
    for line_number, line in enumerate(str(text or "").splitlines(), start=1):
        if not line.strip():
            continue
        match = pattern.match(line)
        if not match:
            errors.append({"line": line_number, "text": line, "message": "형식을 읽지 못했습니다."})
            continue
        year, month, day = re.split(r"[.\-/]", match.group("date"))
        start = match.group("start")
        end = match.group("end")
        records.append({
            "line": line_number,
            "name": match.group("name").strip(),
            "employeeName": match.group("name").strip(),
            "date": f"{int(year):04d}-{int(month):02d}-{int(day):02d}",
            "startTime": start,
            "endTime": end,
            "minutes": minutes_from_time_range(start, end),
            "duration": match.group("duration") or "",
            "raw": line,
        })
    return records, errors


def entry_approval_key(entry):
    return (normalize_name(entry.get("employeeName")), str(entry.get("date") or ""))


def exact_time_match(entry, record):
    return (
        str(entry.get("startTime") or "")[:5] == record["startTime"]
        and str(entry.get("endTime") or "")[:5] == record["endTime"]
    )


def compare_approval_text(collect_folders, approval_text):
    collected = aggregate_collected(collect_folders)
    entries = collected.get("entries") or []
    records, errors = parse_approval_lines(approval_text)
    entries_by_day = {}
    for entry in entries:
        entries_by_day.setdefault(entry_approval_key(entry), []).append(entry)

    approved = []
    mismatches = []
    missing_journal = []
    matched_ids = set()

    for record in records:
        candidates = entries_by_day.get((normalize_name(record["employeeName"]), record["date"]), [])
        if not candidates:
            missing_journal.append({"record": record, "status": "missing_journal", "label": "일지 누락"})
            continue
        exact = next((entry for entry in candidates if exact_time_match(entry, record)), None)
        if exact:
            approved.append({"record": record, "entry": exact, "status": "approved", "label": "결재 완료"})
            matched_ids.add(str(exact.get("id") or ""))
            continue
        entry = candidates[0]
        mismatches.append({"record": record, "entry": entry, "status": "time_mismatch", "label": "시간 상이"})
        matched_ids.add(str(entry.get("id") or ""))

    approved_records = [
        {
            "employeeName": item["record"]["employeeName"],
            "date": item["record"]["date"],
            "startTime": item["record"]["startTime"],
            "endTime": item["record"]["endTime"],
            "raw": item["record"]["raw"],
        }
        for item in approved
    ]
    for item in approved:
        set_approval_for_entries([item["entry"]], "approved", "결재 완료 목록과 일치", item["record"])
    for item in mismatches:
        set_approval_for_entries([item["entry"]], "time_mismatch", "결재 완료 목록과 시간이 다름", item["record"])

    approval_missing = []
    approval_keys = {(normalize_name(record["employeeName"]), record["date"]) for record in records}
    for entry in entries:
        if entry_approval_key(entry) in approval_keys:
            continue
        if str(entry.get("approvalStatus") or "") == "approved":
            continue
        approval_missing.append({"entry": entry, "status": "approval_missing", "label": "결재 누락"})

    decorate_entries_with_approval(entries)
    return {
        "ok": True,
        "records": records,
        "errors": errors,
        "approved": approved,
        "mismatches": mismatches,
        "missingJournal": missing_journal,
        "approvalMissing": approval_missing,
        "approvedCount": len(approved),
        "mismatchCount": len(mismatches),
        "missingJournalCount": len(missing_journal),
        "approvalMissingCount": len(approval_missing),
        "updatedCount": len(approved) + len(mismatches),
        "approvedRecords": approved_records,
        "warnings": collected.get("warnings") or [],
    }


def submit_approval_entries(entries):
    count = set_approval_for_entries(entries, "submitted", "관리자가 결재 올림 처리")
    return {"ok": True, "updatedCount": count}


def cancel_approval_entries(entries):
    count = clear_approval_for_entries(entries)
    return {"ok": True, "updatedCount": count}


def infer_employee_name_from_path(folder_path) -> str:
    try:
        parts = Path(str(folder_path)).parts
    except (TypeError, ValueError):
        return ""
    for part in reversed(parts):
        compact = re.sub(r"[\s._-]+", "", str(part))
        if not compact:
            continue
        if any(word in compact for word in EMPLOYEE_PATH_SKIP_WORDS):
            continue
        match = EMPLOYEE_PATH_NAME_PATTERN.search(str(part).strip())
        if match:
            return match.group(1)
    return ""


def add_target_from_folder(targets, folder_path):
    name = infer_employee_name_from_path(folder_path)
    normalized = normalize_name(name)
    if not normalized or normalized in targets:
        return
    try:
        root = journal_dir(folder_path)
    except OvertimeError:
        return
    targets[normalized] = {
        "employeeName": name,
        "normalizedName": normalized,
        "baseFolder": str(root),
        "journalDir": str(root),
        "lastDate": "",
        "source": "folder",
    }


def employee_target_map(collect_folders):
    collected = aggregate_collected(collect_folders)
    targets = {}
    for entry in collected.get("entries") or []:
        name = str(entry.get("employeeName") or "").strip()
        normalized = normalize_name(name)
        root = entry_journal_root(entry)
        if not normalized or not root:
            continue
        current = targets.get(normalized)
        date_value = str(entry.get("date") or "")
        if not current or date_value > current.get("lastDate", ""):
            targets[normalized] = {
                "employeeName": name,
                "normalizedName": normalized,
                "baseFolder": str(root),
                "journalDir": str(root),
                "lastDate": date_value,
                "source": "entry",
            }
    for folder in collect_folders or []:
        add_target_from_folder(targets, folder)
    return targets


def proxy_name_lookup(targets):
    return {value["normalizedName"]: value for value in targets.values()}


def proxy_block_text(entry_date, start_time, end_time):
    weekdays = "월화수목금토일"
    return f"{entry_date.year}.{entry_date.month:02d}.{entry_date.day:02d}({weekdays[entry_date.weekday()]}) {start_time}~{end_time}\n업무내용 입력"


def proxy_draft(collect_folders, attendance_folders, options=None, target_date=""):
    targets = employee_target_map(collect_folders)
    if target_date:
        date_value = str(target_date)
    else:
        date_value = (dt.date.today() - dt.timedelta(days=1)).isoformat()
    collected = aggregate_collected(collect_folders)
    report = build_attendance_report(
        attendance_folders or [],
        collected.get("entries") or [],
        options or {},
        "",
    )
    allowed = set(targets.keys())
    issues = [
        issue for issue in report.get("issues", [])
        if issue.get("date") == date_value and normalize_name(issue.get("employeeName")) in allowed
    ]
    blocks = []
    entry_date = dt.date.fromisoformat(date_value)
    start_time = (options or {}).get("overtimeStart") or "18:00"
    for issue in sorted(issues, key=lambda item: normalize_name(item.get("employeeName"))):
        end_time = str(issue.get("roundedCheckOut") or issue.get("lastCheckOut") or "00:00")[:5]
        blocks.append(f"{issue.get('employeeName')}\n{proxy_block_text(entry_date, start_time, end_time)}")
    return {
        "ok": True,
        "date": date_value,
        "text": "\n\n".join(blocks),
        "count": len(blocks),
        "targets": list(targets.values()),
        "issues": issues,
        "warnings": report.get("warnings") or [],
    }


def parse_proxy_entries(proxy_text, collect_folders, created_by=""):
    targets = employee_target_map(collect_folders)
    lookup = proxy_name_lookup(targets)
    blocks = []
    current_name = ""
    current_lines = []
    errors = []

    def flush():
        if not current_name:
            return
        text = "\n".join(current_lines).strip()
        if not text:
            return
        target = lookup.get(normalize_name(current_name))
        if not target:
            errors.append({"line": 0, "text": current_name, "message": "저장 대상 직원 폴더를 찾지 못했습니다."})
            return
        parsed = parse_entries(text, target["employeeName"])
        for entry in parsed.get("entries") or []:
            entry["employeeName"] = target["employeeName"]
            entry["targetBaseFolder"] = target["baseFolder"]
            entry["targetJournalDir"] = target["journalDir"]
            entry["proxyInput"] = True
            entry["createdBy"] = created_by
            entry["createdByName"] = created_by
        blocks.append({
            "employeeName": target["employeeName"],
            "targetBaseFolder": target["baseFolder"],
            "entries": parsed.get("entries") or [],
        })
        for error in parsed.get("errors") or []:
            errors.append({**error, "employeeName": target["employeeName"]})

    for line_number, line in enumerate(str(proxy_text or "").splitlines(), start=1):
        normalized = normalize_name(line)
        if normalized in lookup and line.strip():
            flush()
            current_name = lookup[normalized]["employeeName"]
            current_lines = []
            continue
        if current_name:
            current_lines.append(line)
        elif line.strip():
            errors.append({"line": line_number, "text": line, "message": "직원 이름 줄을 먼저 넣어주세요."})
    flush()

    entries = [entry for block in blocks for entry in block["entries"]]
    return {
        "ok": True,
        "entries": entries,
        "blocks": blocks,
        "errors": errors,
        "count": len(entries),
        "targets": list(targets.values()),
    }


def save_proxy_entries(entries, created_by=""):
    grouped = {}
    for entry in entries or []:
        base_folder = str(entry.get("targetBaseFolder") or "").strip()
        employee_name = str(entry.get("employeeName") or "").strip()
        if not base_folder or not employee_name:
            continue
        payload = dict(entry)
        payload["proxyInput"] = True
        payload["createdBy"] = created_by or payload.get("createdBy") or ""
        payload["createdByName"] = created_by or payload.get("createdByName") or ""
        grouped.setdefault((base_folder, employee_name), []).append(payload)
    saved = []
    warnings = []
    for (base_folder, employee_name), group_entries in grouped.items():
        try:
            payload = save_entries(base_folder, group_entries, employee_name)
            saved.extend(payload.get("saved") or [])
        except Exception as error:
            warnings.append({"employeeName": employee_name, "baseFolder": base_folder, "message": str(error)})
    return {
        "ok": True,
        "saved": saved,
        "count": len(saved),
        "warnings": warnings,
    }


class OvertimeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.client_lock = threading.Lock()
        self.clients = {}
        self.shutdown_timer = None

    def _cancel_shutdown_locked(self):
        if self.shutdown_timer:
            self.shutdown_timer.cancel()
            self.shutdown_timer = None

    def mark_client_open(self, client_id):
        client_id = str(client_id or "").strip()
        if not client_id:
            return
        with self.client_lock:
            self.clients[client_id] = time.monotonic()
            self._cancel_shutdown_locked()

    def mark_client_ping(self, client_id):
        client_id = str(client_id or "").strip()
        if not client_id:
            return
        with self.client_lock:
            if client_id in self.clients:
                self.clients[client_id] = time.monotonic()

    def mark_client_close(self, client_id):
        client_id = str(client_id or "").strip()
        with self.client_lock:
            if client_id:
                self.clients.pop(client_id, None)
            if not self.clients:
                self._schedule_shutdown_locked(2.5)

    def _schedule_shutdown_locked(self, delay):
        self._cancel_shutdown_locked()
        self.shutdown_timer = threading.Timer(delay, self._shutdown_if_idle)
        self.shutdown_timer.daemon = True
        self.shutdown_timer.start()

    def _shutdown_if_idle(self):
        with self.client_lock:
            if self.clients:
                return
        threading.Thread(target=self.shutdown, daemon=True).start()


class OvertimeHandler(SimpleHTTPRequestHandler):
    server_version = "OvertimeJournal/0.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

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
        path = urlparse(self.path).path
        if path == "/api/health":
            self.write_json({
                "ok": True,
                "name": APP_NAME,
                "version": APP_VERSION,
                "settingsPath": str(SETTINGS_PATH),
            })
            return
        if path == "/api/settings":
            self.write_json({"ok": True, "settings": load_settings()})
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/client/open":
                body = self.read_json_body()
                self.server.mark_client_open(body.get("clientId") or "")
                self.write_json({"ok": True})
                return
            if path == "/api/client/ping":
                body = self.read_json_body()
                self.server.mark_client_ping(body.get("clientId") or "")
                self.write_json({"ok": True})
                return
            if path == "/api/client/close":
                body = self.read_json_body()
                self.server.mark_client_close(body.get("clientId") or "")
                self.write_json({"ok": True})
                return
            if path == "/api/settings":
                self.write_json({"ok": True, "settings": save_settings(self.read_json_body())})
                return
            if path == "/api/data-root/employees":
                body = self.read_json_body()
                employees = data_root_employees(body.get("dataRoot") or "")
                employee_ranks = normalize_employee_ranks(body.get("employeeRanks"))
                for employee in employees:
                    employee["rank"] = employee_ranks.get(employee["employeeName"], "")
                self.write_json({"ok": True, "employees": employees, "count": len(employees)})
                return
            if path == "/api/select-folder":
                body = self.read_json_body()
                folder = choose_folder(body.get("initialDir") or "", body.get("title") or "폴더 선택")
                self.write_json({"ok": True, "cancelled": not bool(folder), "folder": folder})
                return
            if path == "/api/select-file":
                body = self.read_json_body()
                file_path = choose_file(body.get("initialDir") or "", body.get("title") or "백업 파일 선택")
                self.write_json({"ok": True, "cancelled": not bool(file_path), "file": file_path})
                return
            if path == "/api/parse":
                body = self.read_json_body()
                self.write_json(parse_entries(body.get("text") or "", body.get("employeeName") or ""))
                return
            if path == "/api/save":
                body = self.read_json_body()
                self.write_json(save_entries(
                    body.get("baseFolder") or "",
                    body.get("entries") or [],
                    body.get("employeeName") or "",
                ))
                return
            if path == "/api/proxy/draft":
                body = self.read_json_body()
                self.write_json(proxy_draft(
                    body.get("collectFolders") or [],
                    body.get("attendanceFolders") or [],
                    body.get("options") or {},
                    body.get("date") or "",
                ))
                return
            if path == "/api/proxy/parse":
                body = self.read_json_body()
                self.write_json(parse_proxy_entries(
                    body.get("text") or "",
                    body.get("collectFolders") or [],
                    body.get("createdBy") or "",
                ))
                return
            if path == "/api/proxy/save":
                body = self.read_json_body()
                self.write_json(save_proxy_entries(
                    body.get("entries") or [],
                    body.get("createdBy") or "",
                ))
                return
            if path == "/api/list":
                body = self.read_json_body()
                base_folder = body.get("baseFolder") or ""
                entries = list_entries(base_folder)
                decorate_entries_with_approval(entries)
                self.write_json({
                    "ok": True,
                    "journalDir": str(journal_dir(base_folder)),
                    "entries": entries,
                    "count": len(entries),
                })
                return
            if path == "/api/delete":
                body = self.read_json_body()
                self.write_json(delete_entry(body.get("baseFolder") or "", body.get("id") or ""))
                return
            if path == "/api/trash/list":
                body = self.read_json_body()
                if body.get("baseFolder"):
                    items = list_trash_entries(
                        body.get("baseFolder") or "",
                        body.get("employeeName") or "",
                    )
                    self.write_json({"ok": True, "items": items, "count": len(items)})
                else:
                    self.write_json(aggregate_trash(
                        body.get("collectFolders") or [],
                        body.get("employeeName") or "",
                    ))
                return
            if path == "/api/trash/delete":
                body = self.read_json_body()
                self.write_json(move_entry_to_trash(
                    body.get("baseFolder") or "",
                    body.get("id") or "",
                    body.get("deletedBy") or "",
                ))
                return
            if path == "/api/trash/restore":
                body = self.read_json_body()
                self.write_json(restore_trash_entry(
                    body.get("baseFolder") or "",
                    body.get("trashPath") or body.get("id") or "",
                ))
                return
            if path == "/api/trash/purge":
                body = self.read_json_body()
                self.write_json(purge_trash_entry(
                    body.get("baseFolder") or "",
                    body.get("trashPath") or body.get("id") or "",
                ))
                return
            if path == "/api/update":
                body = self.read_json_body()
                self.write_json(update_entry(
                    body.get("baseFolder") or "",
                    body.get("id") or "",
                    body.get("entry") or {},
                    body.get("employeeName") or "",
                ))
                return
            if path == "/api/backup/create":
                body = self.read_json_body()
                self.write_json(create_user_backup(
                    body.get("baseFolder") or "",
                    body.get("employeeName") or "",
                    "manual",
                ))
                return
            if path == "/api/backup/restore":
                body = self.read_json_body()
                self.write_json(restore_backup_to_folder(
                    body.get("baseFolder") or "",
                    body.get("backupPath") or "",
                    body.get("employeeName") or "",
                ))
                return
            if path == "/api/collect":
                body = self.read_json_body()
                self.write_json(aggregate_collected(body.get("collectFolders") or body.get("roots") or []))
                return
            if path == "/api/approval/submit":
                body = self.read_json_body()
                self.write_json(submit_approval_entries(body.get("entries") or []))
                return
            if path == "/api/approval/cancel":
                body = self.read_json_body()
                self.write_json(cancel_approval_entries(body.get("entries") or []))
                return
            if path == "/api/approval/compare":
                body = self.read_json_body()
                self.write_json(compare_approval_text(
                    body.get("collectFolders") or [],
                    body.get("text") or "",
                ))
                return
            if path == "/api/admin/backup":
                body = self.read_json_body()
                self.write_json(create_admin_backup(
                    body.get("collectFolders") or [],
                    body.get("employeeName") or "",
                ))
                return
            if path == "/api/admin/restore":
                body = self.read_json_body()
                self.write_json(restore_backup_to_original_paths(
                    body.get("backupPath") or "",
                    body.get("employeeName") or "",
                ))
                return
            if path == "/api/attendance/report":
                body = self.read_json_body()
                collect_folders = body.get("collectFolders") or []
                base_folder = body.get("baseFolder") or ""
                if base_folder:
                    overtime_entries = list_entries(base_folder)
                else:
                    overtime_entries = aggregate_collected(collect_folders).get("entries") or []
                report = build_attendance_report(
                    body.get("attendanceFolders") or [],
                    overtime_entries,
                    body.get("options") or {},
                    body.get("employeeName") or "",
                )
                if not base_folder and collect_folders:
                    allowed_names = set(employee_target_map(collect_folders).keys())
                    for key in ("records", "issues", "suggestions"):
                        report[key] = [
                            item for item in report.get(key, [])
                            if normalize_name(item.get("employeeName")) in allowed_names
                        ]
                self.write_json(report)
                return
            self.write_json({"error": "Unknown API endpoint"}, status=404)
        except OvertimeError as error:
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

    def log_message(self, format, *args):
        app_log(f"[OvertimeJournal] {format % args}")


def free_port(preferred):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]


def parse_args(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8877)
    parser.add_argument("--no-open", action="store_true")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    port = free_port(args.port)
    server = OvertimeHTTPServer((args.host, port), OvertimeHandler)
    url = f"http://{args.host}:{port}/"
    app_log(f"Overtime Journal running at {url}")
    app_log(f"Settings: {SETTINGS_PATH}")
    app_log("Press Ctrl+C to stop.")
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url, new=1, autoraise=True)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        app_log("\nStopping Overtime Journal...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

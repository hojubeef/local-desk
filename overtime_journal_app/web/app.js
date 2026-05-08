(function () {
  const sampleText = `2026.05.06(수) 18:00~20:00
2026년도 하수도 맨홀추락방지시설 설치공사(3차) 도면 작업

2026.05.07(목) 18:30~21:00
상수도 급수공사 수량산출서 정리`;

  const weekdays = ["일", "월", "화", "수", "목", "금", "토"];
  const rankOptions = ["전무", "상무", "이사", "차장", "과장", "대리", "사원"];

  const state = {
    settings: {
      dataRoot: "",
      dataRootEmployees: [],
      selectedEmployees: [],
      employeeRanks: {},
      collectFolders: [],
      attendanceFolders: [],
      hideOldIssues: true,
      startupEnabled: false
    },
    parsedEntries: [],
    parseErrors: [],
    myEntries: [],
    adminEntries: [],
    adminTrash: [],
    warnings: [],
    attendanceReport: { issues: [], suggestions: [], records: [] },
    adminAttendanceReport: { issues: [], records: [] },
    proxyAttendanceReport: { issues: [], records: [] },
    selectedApprovalIds: new Set(),
    myCalendarDate: new Date(),
    adminCalendarDate: new Date(),
    quickCalendarDate: new Date(),
    employeeCalendarDate: new Date(),
    selectedDate: "",
    adminSelectedDate: "",
    employeeSelectedDate: "",
    editContext: null,
    activeTab: "quick"
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const clientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let clientPingTimer = null;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setStatus(message, tone) {
    const node = $("#appStatus");
    node.textContent = message;
    node.dataset.tone = tone || "";
  }

  async function request(path, body, method) {
    const response = await fetch(path, {
      method: method || (body === undefined ? "GET" : "POST"),
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `요청 실패 (${response.status})`);
    }
    return payload;
  }

  function sendLifecycle(path) {
    const body = JSON.stringify({ clientId });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(path, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true
    }).catch(() => {});
  }

  function startClientLifecycle() {
    request("/api/client/open", { clientId }).catch(() => {});
    clientPingTimer = window.setInterval(() => {
      request("/api/client/ping", { clientId }).catch(() => {});
    }, 5000);
    window.addEventListener("pagehide", () => {
      if (clientPingTimer) window.clearInterval(clientPingTimer);
      sendLifecycle("/api/client/close");
    });
  }

  function todayMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthToDate(value) {
    const month = value || todayMonth();
    return new Date(`${month}-01T00:00:00`);
  }

  function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function dotDate(key) {
    const date = new Date(`${key}T00:00:00`);
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}(${weekdays[date.getDay()]})`;
  }

  function formatMoney(value) {
    return `${Math.round(Number(value || 0)).toLocaleString("ko-KR")}원`;
  }

  function formatHours(minutes) {
    const value = Number(minutes || 0) / 60;
    return `${value.toFixed(value % 1 === 0 ? 0 : 1)}시간`;
  }

  function entryTime(entry) {
    return `${entry.startTime || ""}~${entry.endTime || ""}`;
  }

  function entryMonth(entry) {
    return String(entry.date || "").slice(0, 7);
  }

  function shortWork(work, length = 22) {
    const text = String(work || "").replace(/\s+/g, " ").trim();
    return text.length > length ? `${text.slice(0, length)}...` : text;
  }

  function currentEmployeeName() {
    return $("#employeeName").value.trim();
  }

  function currentDataRoot() {
    return $("#dataRoot")?.value.trim() || state.settings.dataRoot || "";
  }

  function currentBaseFolder() {
    return $("#baseFolder")?.value.trim() || "";
  }

  function proxyModeEnabled() {
    return $("#proxyModeEnabled")?.checked === true;
  }

  function collectFolders() {
    const root = state.settings.dataRoot || currentDataRoot();
    const selected = selectedEmployees();
    if (root && selected.length) {
      const separator = root.includes("/") && !root.includes("\\") ? "/" : "\\";
      return selected.map((name) => `${root.replace(/[\\\/]+$/, "")}${separator}${name}`);
    }
    return Array.isArray(state.settings.collectFolders) ? state.settings.collectFolders : [];
  }

  function selectedEmployees() {
    return Array.isArray(state.settings.selectedEmployees) ? state.settings.selectedEmployees : [];
  }

  function attendanceFolders() {
    return Array.isArray(state.settings.attendanceFolders) ? state.settings.attendanceFolders : [];
  }

  function attendanceOptions() {
    return {
      lateThreshold: $("#lateThreshold").value || "18:30",
      overtimeStart: $("#overtimeStart").value || "18:00",
      roundingMinutes: 5,
      hideOldIssues: $("#hideOldIssues").checked,
      startupEnabled: $("#startupEnabled").checked,
      nightHourlyWage: Number($("#nightHourlyWage")?.value || 0),
      ignoreMissingCheckIn: $("#ignoreMissingCheckIn").checked,
      ignoreMissingCheckOut: $("#ignoreMissingCheckOut").checked
    };
  }

  function settingsPayload() {
    return {
      employeeName: currentEmployeeName(),
      dataRoot: currentDataRoot(),
      baseFolder: currentBaseFolder(),
      selectedEmployees: selectedEmployees(),
      employeeRanks: state.settings.employeeRanks || {},
      collectFolders: collectFolders(),
      attendanceFolders: attendanceFolders(),
      ...attendanceOptions()
    };
  }

  function filteredByMonth(entries, month) {
    return entries.filter((entry) => entryMonth(entry) === month);
  }

  function visibleIssues(issues, month) {
    return (issues || []).filter((issue) => {
      const issueMonth = String(issue.date || "").slice(0, 7);
      if (state.settings.hideOldIssues && issueMonth < todayMonth()) return false;
      return month ? issueMonth === month : true;
    });
  }

  function summarize(entries) {
    const totalMinutes = entries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
    const days = new Set(entries.map((entry) => entry.date).filter(Boolean)).size;
    const employees = new Set(entries.map((entry) => entry.employeeName).filter(Boolean)).size;
    return { totalMinutes, days, employees, count: entries.length };
  }

  function renderSummaryCards(node, entries, mode) {
    const summary = summarize(entries);
    const cards = [
      ["총 시간", formatHours(summary.totalMinutes)],
      ["기록 수", `${summary.count}건`],
      ["야근일수", `${summary.days}일`]
    ];
    if (mode === "admin") cards[2] = ["인원", `${summary.employees}명`];
    node.innerHTML = cards.map(([label, value]) => `
      <div class="summary-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join("");
  }

  function renderSettings(settings) {
    state.settings = {
      employeeName: settings?.employeeName || "",
      dataRoot: settings?.dataRoot || "",
      baseFolder: settings?.baseFolder || "",
      journalDir: settings?.journalDir || "",
      dataRootEmployees: Array.isArray(settings?.dataRootEmployees) ? settings.dataRootEmployees : [],
      selectedEmployees: Array.isArray(settings?.selectedEmployees) ? settings.selectedEmployees : [],
      employeeRanks: settings?.employeeRanks && typeof settings.employeeRanks === "object" ? settings.employeeRanks : {},
      collectFolders: Array.isArray(settings?.collectFolders) ? settings.collectFolders : [],
      attendanceFolders: Array.isArray(settings?.attendanceFolders) ? settings.attendanceFolders : [],
      lateThreshold: settings?.lateThreshold || "18:30",
      overtimeStart: settings?.overtimeStart || "18:00",
      hideOldIssues: settings?.hideOldIssues !== false,
      startupEnabled: settings?.startupEnabled === true,
      nightHourlyWage: Number(settings?.nightHourlyWage || 0),
      ignoreMissingCheckIn: settings?.ignoreMissingCheckIn !== false,
      ignoreMissingCheckOut: settings?.ignoreMissingCheckOut !== false
    };
    $("#employeeName").value = state.settings.employeeName;
    $("#dataRoot").value = state.settings.dataRoot;
    $("#baseFolder").value = state.settings.baseFolder;
    $("#journalDirText").textContent = state.settings.journalDir || "-";
    $("#lateThreshold").value = state.settings.lateThreshold;
    $("#overtimeStart").value = state.settings.overtimeStart;
    $("#hideOldIssues").checked = state.settings.hideOldIssues;
    $("#startupEnabled").checked = state.settings.startupEnabled;
    $("#nightHourlyWage").value = state.settings.nightHourlyWage || "";
    $("#ignoreMissingCheckIn").checked = state.settings.ignoreMissingCheckIn;
    $("#ignoreMissingCheckOut").checked = state.settings.ignoreMissingCheckOut;
    renderEmployeePicker();
    renderFolderList("attendance");
  }

  function renderFolderList(kind) {
    const folders = attendanceFolders();
    const node = $("#attendanceFolderList");
    const emptyText = "등록된 출퇴근 기록 폴더가 없습니다.";
    node.innerHTML = folders.length ? folders.map((folder, index) => `
      <div class="folder-item">
        <span>${escapeHtml(folder)}</span>
        <button class="icon-text danger" type="button" data-remove-folder="${kind}" data-folder-index="${index}">삭제</button>
      </div>
    `).join("") : `<div class="empty compact">${emptyText}</div>`;
  }

  function renderEmployeePicker() {
    const node = $("#collectFolderList");
    if (!node) return;
    const employees = Array.isArray(state.settings.dataRootEmployees) ? state.settings.dataRootEmployees : [];
    const selected = new Set(selectedEmployees().map((name) => normalizeNameKey(name)));
    if (!state.settings.dataRoot) {
      node.innerHTML = '<div class="empty compact">데이터 루트 폴더를 먼저 선택하세요.</div>';
      return;
    }
    if (!employees.length) {
      node.innerHTML = '<div class="empty compact">루트 안에 직원 폴더가 없습니다.</div>';
      return;
    }
    node.innerHTML = employees.map((employee) => {
      const name = employee.employeeName || "";
      const checked = selected.has(normalizeNameKey(name)) ? " checked" : "";
      const rank = employeeRank(name) || employee.rank || "";
      return `
        <div class="employee-check">
          <label class="employee-select-line">
            <input type="checkbox" data-employee-select="${escapeHtml(name)}"${checked}>
            <span>${escapeHtml(name)}</span>
          </label>
          <select class="employee-rank-select" data-employee-rank="${escapeHtml(name)}" title="${escapeHtml(name)} 직급">
            ${rankOptionsMarkup(rank)}
          </select>
          <small>${escapeHtml(employee.journalDir || "")}</small>
        </div>
      `;
    }).join("");
  }

  function normalizeNameKey(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function employeeRank(name) {
    return (state.settings.employeeRanks || {})[name] || "";
  }

  function rankIndex(name) {
    const index = rankOptions.indexOf(employeeRank(name));
    return index >= 0 ? index : rankOptions.length;
  }

  function compareEmployeeByRankThenName(a, b) {
    const rankDiff = rankIndex(a) - rankIndex(b);
    if (rankDiff) return rankDiff;
    return String(a || "").localeCompare(String(b || ""), "ko");
  }

  function compareEntriesByDateRankNameTime(a, b) {
    const dateDiff = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateDiff) return dateDiff;
    const rankDiff = rankIndex(a.employeeName) - rankIndex(b.employeeName);
    if (rankDiff) return rankDiff;
    const nameDiff = String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "ko");
    if (nameDiff) return nameDiff;
    return String(a.startTime || "").localeCompare(String(b.startTime || ""));
  }

  function compareIssuesByDateRankNameTime(a, b) {
    const dateDiff = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateDiff) return dateDiff;
    const rankDiff = rankIndex(a.employeeName) - rankIndex(b.employeeName);
    if (rankDiff) return rankDiff;
    const nameDiff = String(a.employeeName || "").localeCompare(String(b.employeeName || ""), "ko");
    if (nameDiff) return nameDiff;
    return String(a.roundedCheckOut || a.lastCheckOut || "").localeCompare(String(b.roundedCheckOut || b.lastCheckOut || ""));
  }

  function employeeRankLabel(name) {
    return employeeRank(name) || "-";
  }

  function employeeDisplayName(name) {
    const text = String(name || "");
    const rank = employeeRank(name);
    return rank ? `${rank} ${text}` : text;
  }

  function rankOptionsMarkup(current) {
    return [
      '<option value="">직급</option>',
      ...rankOptions.map((rank) => `<option value="${escapeHtml(rank)}"${rank === current ? " selected" : ""}>${escapeHtml(rank)}</option>`)
    ].join("");
  }

  async function loadSettings() {
    try {
      const payload = await request("/api/settings");
      renderSettings(payload.settings);
      setStatus("준비 완료", "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function saveSettings() {
    const payload = await request("/api/settings", settingsPayload());
    renderSettings(payload.settings);
    setStatus("설정 저장", "ok");
  }

  async function refreshDataRootEmployees() {
    if (!currentDataRoot()) {
      setStatus("데이터 루트 폴더를 먼저 선택하세요.", "warn");
      return;
    }
    try {
      await saveSettings();
      renderEmployeePicker();
      setStatus("직원 목록 새로고침", "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function pickFolder(initialDir, title) {
    const payload = await request("/api/select-folder", { initialDir, title });
    return payload.cancelled ? "" : payload.folder;
  }

  async function pickFile(initialDir, title) {
    const payload = await request("/api/select-file", { initialDir, title });
    return payload.cancelled ? "" : payload.file;
  }

  function myBackupDir() {
    return state.settings.journalDir ? `${state.settings.journalDir}\\backups` : "";
  }

  async function chooseDataRootFolder() {
    try {
      const folder = await pickFolder(currentDataRoot(), "데이터 루트 폴더 선택");
      if (!folder) return;
      $("#dataRoot").value = folder;
      await saveSettings();
      await loadMine();
      await collectAdmin();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function addFolder(kind) {
    try {
      const folders = attendanceFolders();
      const title = "출퇴근 기록 폴더 선택";
      const folder = await pickFolder(folders[folders.length - 1] || "", title);
      if (!folder) return;
      const exists = folders.some((item) => item.toLowerCase() === folder.toLowerCase());
      if (!exists) {
        state.settings.attendanceFolders = [...folders, folder];
        await saveSettings();
        await refreshAttendanceViews();
      }
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function removeFolder(kind, index) {
    if (kind === "collect") {
      state.settings.collectFolders = collectFolders().filter((_folder, folderIndex) => folderIndex !== Number(index));
    } else {
      state.settings.attendanceFolders = attendanceFolders().filter((_folder, folderIndex) => folderIndex !== Number(index));
    }
    try {
      await saveSettings();
      await refreshAttendanceViews();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function createMyBackup() {
    if (!currentBaseFolder()) {
      setStatus("내 웹하드 폴더를 먼저 선택하세요.", "warn");
      return;
    }
    try {
      const payload = await request("/api/backup/create", {
        baseFolder: currentBaseFolder(),
        employeeName: currentEmployeeName()
      });
      $("#myBackupStatus").textContent = `${payload.count || 0}건 백업 완료 · ${payload.path || ""}`;
      setStatus("내 백업 생성 완료", "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function restoreMyBackup() {
    if (!currentBaseFolder()) {
      setStatus("복원할 내 웹하드 폴더를 먼저 선택하세요.", "warn");
      return;
    }
    try {
      const file = await pickFile(myBackupDir(), "불러올 야근일지 백업 파일 선택");
      if (!file) return;
      if (!confirm("선택한 백업에서 없는 기록만 내 폴더로 복원할까요?")) return;
      const payload = await request("/api/backup/restore", {
        baseFolder: currentBaseFolder(),
        backupPath: file,
        employeeName: currentEmployeeName()
      });
      $("#myBackupStatus").textContent = `복원 ${payload.restoredCount || 0}건 · 이미 있음 ${payload.skippedCount || 0}건 · 오류 ${payload.errorCount || 0}건`;
      setStatus("백업 불러오기 완료", payload.errorCount ? "warn" : "ok");
      await loadMine();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function parseQuickText() {
    const text = $("#quickText").value;
    if (!text.trim()) {
      setStatus("입력 내용 없음", "warn");
      return;
    }
    try {
      const payload = proxyModeEnabled()
        ? await request("/api/proxy/parse", {
            text,
            collectFolders: collectFolders(),
            createdBy: currentEmployeeName()
          })
        : await request("/api/parse", {
            text,
            employeeName: currentEmployeeName()
          });
      state.parsedEntries = payload.entries || [];
      state.parseErrors = payload.errors || [];
      renderPreviewProxyAware();
      $("#saveParsedButton").disabled = state.parsedEntries.length === 0;
      setStatus(`${state.parsedEntries.length}건 인식`, state.parseErrors.length ? "warn" : "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function tableMarkup(rows, headers) {
    return `
      <div class="table-scroll">
        <table>
          <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderPreview() {
    $("#previewCount").textContent = `${state.parsedEntries.length}건`;
    const rows = state.parsedEntries.map((entry, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(entry.date)}(${escapeHtml(entry.weekday)})</td>
        <td>${escapeHtml(entryTime(entry))}</td>
        <td>${escapeHtml(formatHours(entry.minutes))}</td>
        <td>${escapeHtml(entry.work || "")}</td>
      </tr>
    `).join("");
    const errors = state.parseErrors.length ? `
      <div class="error-list">
        ${state.parseErrors.map((error) => `
          <p><strong>${escapeHtml(error.line)}줄</strong> ${escapeHtml(error.message)} <span>${escapeHtml(error.text)}</span></p>
        `).join("")}
      </div>
    ` : "";

    if (!rows && !errors) {
      $("#previewPane").innerHTML = '<div class="empty">인식된 야근일지가 없습니다.</div>';
      return;
    }
    $("#previewPane").innerHTML = `
      ${rows ? tableMarkup(rows, ["#", "날짜", "시간", "합계", "업무내용"]) : ""}
      ${errors}
    `;
  }

  function renderPreviewProxyAware() {
    $("#previewCount").textContent = `${state.parsedEntries.length}건`;
    const isProxy = proxyModeEnabled();
    const rows = state.parsedEntries.map((entry, index) => `
      <tr>
        <td>${index + 1}</td>
        ${isProxy ? `<td>${escapeHtml(entry.employeeName || "")}</td>` : ""}
        <td>${escapeHtml(entry.date)}(${escapeHtml(entry.weekday)})</td>
        <td>${escapeHtml(entryTime(entry))}</td>
        <td>${escapeHtml(formatHours(entry.minutes))}</td>
        ${isProxy ? `<td>${escapeHtml(entry.targetJournalDir || entry.targetBaseFolder || "")}</td>` : ""}
        <td>${escapeHtml(entry.work || "")}</td>
      </tr>
    `).join("");
    const errors = state.parseErrors.length ? `
      <div class="error-list">
        ${state.parseErrors.map((error) => `
          <p><strong>${escapeHtml(error.line)}줄</strong> ${escapeHtml(error.message)} <span>${escapeHtml(error.text)}</span></p>
        `).join("")}
      </div>
    ` : "";

    if (!rows && !errors) {
      $("#previewPane").innerHTML = '<div class="empty">인식된 야근일지가 없습니다.</div>';
      return;
    }
    const headers = isProxy
      ? ["#", "대상", "날짜", "시간", "합계", "저장 폴더", "업무내용"]
      : ["#", "날짜", "시간", "합계", "업무내용"];
    $("#previewPane").innerHTML = `
      ${rows ? tableMarkup(rows, headers) : ""}
      ${errors}
    `;
  }

  async function saveProxyEntries() {
    if (!currentEmployeeName()) {
      setStatus("대리 입력자 이름을 먼저 입력하세요.", "warn");
      return;
    }
    if (!state.parsedEntries.length) {
      setStatus("저장할 대리 입력 기록이 없습니다.", "warn");
      return;
    }
    try {
      const payload = await request("/api/proxy/save", {
        entries: state.parsedEntries,
        createdBy: currentEmployeeName()
      });
      state.parsedEntries = [];
      state.parseErrors = [];
      $("#quickText").value = "";
      $("#saveParsedButton").disabled = true;
      $("#previewPane").innerHTML = `<div class="empty">대리 입력 ${payload.count || 0}건을 저장했습니다.</div>`;
      $("#previewCount").textContent = "0건";
      $("#proxyStatus").textContent = `대리 입력 저장 ${payload.count || 0}건`;
      setStatus(`대리 입력 ${payload.count || 0}건 저장`, payload.warnings?.length ? "warn" : "ok");
      if (collectFolders().length) await collectAdmin();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function saveParsedEntries() {
    if (proxyModeEnabled()) {
      await saveProxyEntries();
      return;
    }
    if (!currentEmployeeName()) {
      setStatus("이름을 먼저 입력하세요.", "warn");
      return;
    }
    if (!currentBaseFolder()) {
      setStatus("저장 폴더를 먼저 선택하세요.", "warn");
      return;
    }
    try {
      const payload = await request("/api/save", {
        employeeName: currentEmployeeName(),
        baseFolder: currentBaseFolder(),
        entries: state.parsedEntries
      });
      state.parsedEntries = [];
      state.parseErrors = [];
      $("#quickText").value = "";
      $("#saveParsedButton").disabled = true;
      $("#previewPane").innerHTML = `<div class="empty">${payload.count}건을 저장했습니다.</div>`;
      $("#previewCount").textContent = "0건";
      setStatus(`${payload.count}건 저장`, "ok");
      await loadMine();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function loadMine() {
    if (!currentBaseFolder()) {
      state.myEntries = [];
      state.attendanceReport = { issues: [], suggestions: [], records: [] };
      renderMine();
      renderSuggestionPane();
      renderQuickHelpers();
      renderQuickCalendar();
      return;
    }
    try {
      const payload = await request("/api/list", { baseFolder: currentBaseFolder() });
      state.myEntries = payload.entries || [];
      $("#journalDirText").textContent = payload.journalDir || "-";
      await loadMyAttendanceData().catch((error) => setStatus(error.message, "warn"));
      renderMine();
      renderSuggestionPane();
      renderQuickHelpers();
      renderQuickCalendar();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function loadMyAttendanceData() {
    if (!attendanceFolders().length || !currentBaseFolder()) {
      state.attendanceReport = { issues: [], suggestions: [], records: [] };
      return;
    }
    const payload = await request("/api/attendance/report", {
      attendanceFolders: attendanceFolders(),
      baseFolder: currentBaseFolder(),
      employeeName: currentEmployeeName(),
      options: attendanceOptions()
    });
    state.attendanceReport = payload;
  }

  async function refreshAttendanceViews() {
    await loadMyAttendanceData().catch(() => {});
    if (state.adminEntries.length) {
      await loadAdminAttendanceData().catch(() => {});
    }
    renderMine();
    renderSuggestionPane();
    renderQuickCalendar();
    renderAdmin();
  }

  function renderSuggestionPane() {
    const suggestions = visibleIssues(state.attendanceReport.suggestions || []);
    const issues = visibleIssues(state.attendanceReport.issues || []);
    if (suggestions.length) {
      const item = suggestions[0];
      $("#attendanceSuggestionPane").innerHTML = `
        <div class="suggestion-card">
          <div>
            <strong>어제 퇴근 ${escapeHtml(item.roundedCheckOut || item.lastCheckOut)}</strong>
            <span>${escapeHtml(item.date)} 야근일지가 없습니다.</span>
          </div>
          <button class="button warning-action small" type="button" data-use-suggestion="${escapeHtml(item.date)}">시간 넣기</button>
        </div>
      `;
      return;
    }
    if (issues.length) {
      $("#attendanceSuggestionPane").innerHTML = `
        <div class="suggestion-card muted">
          <div>
            <strong>확인 필요 ${issues.length}건</strong>
            <span>내 현황 달력에서 노란 날짜를 확인하세요.</span>
          </div>
        </div>
      `;
      return;
    }
    $("#attendanceSuggestionPane").innerHTML = '<div class="empty compact">출퇴근 기록 기준으로 확인할 항목이 없습니다.</div>';
  }

  function useSuggestion(dateValue) {
    const issue = (state.attendanceReport.issues || []).find((item) => item.date === dateValue);
    if (!issue) return;
    const current = $("#quickText").value.trim();
    $("#quickText").value = [current, issue.suggestionText].filter(Boolean).join("\n\n");
    setTab("quick");
    parseQuickText();
  }

  function proxyBlockFromIssue(issue) {
    const start = state.settings.overtimeStart || $("#overtimeStart").value || "18:00";
    const end = String(issue.roundedCheckOut || issue.lastCheckOut || "00:00").slice(0, 5);
    return `${issue.employeeName || ""}\n${dotDate(issue.date)} ${start}~${end}\n업무내용 입력`;
  }

  async function checkProxyAttendance() {
    if (!collectFolders().length) {
      setStatus("대리 퇴근 확인은 관리자 수집 폴더가 필요합니다.", "warn");
      return;
    }
    if (!attendanceFolders().length) {
      setStatus("대리 퇴근 확인은 출퇴근 기록 폴더가 필요합니다.", "warn");
      return;
    }
    try {
      $("#proxyModeEnabled").checked = true;
      const payload = await request("/api/attendance/report", {
        attendanceFolders: attendanceFolders(),
        collectFolders: collectFolders(),
        options: attendanceOptions()
      });
      state.proxyAttendanceReport = payload;
      renderProxyCheckList();
      const count = visibleIssues(payload.issues || []).length;
      $("#proxyStatus").textContent = `수집 폴더 직원 기준 확인 필요 ${count}건`;
      setStatus("대리 퇴근 확인 완료", payload.warnings?.length ? "warn" : "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function proxyIssueSort(a, b) {
    return `${b.date || ""} ${b.employeeName || ""}`.localeCompare(`${a.date || ""} ${a.employeeName || ""}`, "ko");
  }

  function renderProxyCheckList() {
    const issues = visibleIssues(state.proxyAttendanceReport.issues || [])
      .sort(proxyIssueSort)
      .slice(0, 120);
    if (!issues.length) {
      $("#proxyCheckList").innerHTML = '<div class="empty compact">수집 폴더 직원 기준 확인 필요 항목이 없습니다.</div>';
      return;
    }
    $("#proxyCheckList").innerHTML = issues.map((issue, index) => `
      <div class="proxy-check-item">
        <span>${escapeHtml(issue.employeeName || "")}</span>
        <strong>${escapeHtml(issue.date || "")} 퇴근 ${escapeHtml(issue.roundedCheckOut || issue.lastCheckOut || "")}</strong>
        <small>${escapeHtml(issue.reason || "")}</small>
        <button class="icon-text edit-action" type="button" data-proxy-issue-index="${index}">초안 넣기</button>
      </div>
    `).join("");
  }

  function insertProxyIssue(index) {
    const issues = visibleIssues(state.proxyAttendanceReport.issues || [])
      .sort(proxyIssueSort);
    const issue = issues[Number(index)];
    if (!issue) return;
    $("#proxyModeEnabled").checked = true;
    insertQuickText(proxyBlockFromIssue(issue));
    parseQuickText();
  }

  async function createProxyDraft() {
    if (!collectFolders().length) {
      setStatus("대리 입력은 관리자 수집 폴더가 필요합니다.", "warn");
      return;
    }
    if (!attendanceFolders().length) {
      setStatus("어제 대리 초안은 출퇴근 기록 폴더가 필요합니다.", "warn");
      return;
    }
    try {
      $("#proxyModeEnabled").checked = true;
      const payload = await request("/api/proxy/draft", {
        collectFolders: collectFolders(),
        attendanceFolders: attendanceFolders(),
        options: attendanceOptions()
      });
      if (!payload.text) {
        $("#proxyStatus").textContent = "어제 기준으로 대리 입력할 확인 필요 기록이 없습니다.";
        setStatus("대리 초안 없음", "ok");
        return;
      }
      $("#quickText").value = payload.text;
      $("#proxyStatus").textContent = `어제 대리 초안 ${payload.count || 0}명`;
      await parseQuickText();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function deriveTaskName(work) {
    const line = String(work || "").split(/\r?\n/).find((part) => part.trim()) || "";
    const cleaned = line.replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    const markers = [" 도면", " 수량", " 보고서", " 정리", " 검토", " 작성", " 산출", " 작업", " 수정", " 보완", " 협의"];
    const cut = markers
      .map((marker) => cleaned.indexOf(marker))
      .filter((index) => index > 3)
      .sort((a, b) => a - b)[0];
    return shortWork(cut ? cleaned.slice(0, cut) : cleaned, 34);
  }

  function uniqueRecent(values, limit) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      const text = String(value || "").trim();
      const key = text.replace(/\s+/g, " ");
      if (!text || seen.has(key)) continue;
      seen.add(key);
      result.push(text);
      if (result.length >= limit) break;
    }
    return result;
  }

  function renderChips(node, values, emptyText) {
    node.innerHTML = values.length ? values.map((value) => `
      <button class="chip" type="button" data-insert-text="${escapeHtml(value)}" title="${escapeHtml(value)}">
        ${escapeHtml(shortWork(value, 28))}
      </button>
    `).join("") : `<div class="empty compact">${emptyText}</div>`;
  }

  function renderQuickHelpers() {
    const sorted = state.myEntries.slice().sort((a, b) => (
      `${b.date || ""} ${b.startTime || ""}`.localeCompare(`${a.date || ""} ${a.startTime || ""}`)
    ));
    renderChips(
      $("#taskChips"),
      uniqueRecent(sorted.map((entry) => deriveTaskName(entry.work)), 10),
      "저장된 기록이 생기면 과업명이 표시됩니다."
    );
    renderChips(
      $("#recentWorkChips"),
      uniqueRecent(sorted.map((entry) => entry.work), 10),
      "최근 업무내용이 아직 없습니다."
    );
  }

  function insertQuickText(text) {
    const textarea = $("#quickText");
    const current = textarea.value.replace(/\s+$/, "");
    textarea.value = current ? `${current}\n${text}` : text;
    textarea.focus();
  }

  function endTimeForQuickDate(dateValue) {
    const issue = (state.attendanceReport.issues || []).find((item) => item.date === dateValue);
    if (issue?.roundedCheckOut || issue?.lastCheckOut) {
      return String(issue.roundedCheckOut || issue.lastCheckOut).slice(0, 5);
    }
    const record = (state.attendanceReport.records || []).find((item) => item.date === dateValue);
    if (record?.roundedCheckOut || record?.lastCheckOut) {
      return String(record.roundedCheckOut || record.lastCheckOut).slice(0, 5);
    }
    return "00:00";
  }

  function insertDateTemplate(dateValue) {
    const start = state.settings.overtimeStart || $("#overtimeStart").value || "18:00";
    const end = endTimeForQuickDate(dateValue);
    insertQuickText(`${dotDate(dateValue)} ${start}~${end}`);
    parseQuickText();
  }

  function renderQuickCalendar() {
    const target = state.quickCalendarDate;
    const year = target.getFullYear();
    const month = target.getMonth();
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const issueByDay = groupIssuesByDay(visibleIssues(state.attendanceReport.issues || [], monthKey(target)));
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dayKey(date);
      const muted = date.getMonth() !== month ? " muted" : "";
      const needsCheck = issueByDay[key]?.length ? " needs-check" : "";
      cells.push(`
        <button class="mini-day${muted}${needsCheck}" type="button" data-quick-date="${key}">
          <span>${date.getDate()}</span>
        </button>
      `);
    }
    $("#quickCalendarTitle").textContent = `${year}년 ${month + 1}월`;
    $("#quickCalendar").innerHTML = `
      ${weekdays.map((day) => `<div class="weekday">${day}</div>`).join("")}
      ${cells.join("")}
    `;
  }

  function renderMine() {
    const month = $("#recordsMonth").value || todayMonth();
    const entries = filteredByMonth(state.myEntries, month).sort(compareEntriesByDateRankNameTime);
    const issues = visibleIssues(state.attendanceReport.issues || [], month).sort(compareIssuesByDateRankNameTime);
    renderSummaryCards($("#mySummaryCards"), entries, "mine");
    $("#myIssueStrip").innerHTML = issues.length
      ? `<div class="issue-card">${month} 확인 필요 ${issues.length}건. 퇴근 기록은 있는데 야근일지가 없는 날짜가 있습니다.</div>`
      : "";
    renderLimitAlerts($("#myLimitAlerts"), entries, month);
    renderWageSummary(entries);
    renderWeeklySummary($("#weeklySummary"), entries, month);
    renderMyCalendar();
    $("#myEntriesTable").innerHTML = entries.length
      ? entriesTable(entries, { editable: true, deletable: true, source: "mine" })
      : '<div class="empty">이번 달 기록이 없습니다.</div>';
  }

  function weekStartKey(dateValue) {
    const date = new Date(`${dateValue}T00:00:00`);
    date.setDate(date.getDate() - date.getDay());
    return dayKey(date);
  }

  function calculatePaidMinutes(entries) {
    const byDay = {};
    entries.forEach((entry) => {
      byDay[entry.date] = (byDay[entry.date] || 0) + Number(entry.minutes || 0);
    });
    const dailyCapped = Object.entries(byDay).map(([date, minutes]) => ({
      date,
      minutes,
      paidMinutes: Math.min(minutes, 180)
    }));
    const byWeek = {};
    dailyCapped.forEach((item) => {
      const key = weekStartKey(item.date);
      byWeek[key] = (byWeek[key] || 0) + item.paidMinutes;
    });
    const weeklyCappedTotal = Object.values(byWeek).reduce((sum, minutes) => sum + Math.min(minutes, 720), 0);
    return {
      rawMinutes: entries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0),
      dailyCappedMinutes: dailyCapped.reduce((sum, item) => sum + item.paidMinutes, 0),
      weeklyCappedMinutes: weeklyCappedTotal,
      monthlyPaidMinutes: Math.min(weeklyCappedTotal, 1200),
    };
  }

  function limitCheck(entries, month) {
    const byDay = {};
    const byWeek = {};
    let monthMinutes = 0;
    entries.forEach((entry) => {
      const minutes = Number(entry.minutes || 0);
      byDay[entry.date] = (byDay[entry.date] || 0) + minutes;
      byWeek[weekStartKey(entry.date)] = (byWeek[weekStartKey(entry.date)] || 0) + minutes;
      if (entryMonth(entry) === month) monthMinutes += minutes;
    });
    const daily = Object.entries(byDay)
      .filter(([, minutes]) => minutes > 180)
      .map(([date, minutes]) => ({ date, minutes }));
    const weekly = Object.entries(byWeek)
      .filter(([, minutes]) => minutes > 720)
      .map(([week, minutes]) => ({ week, minutes }));
    const nearMonthly = monthMinutes >= 1080 && monthMinutes <= 1200;
    return {
      daily,
      weekly,
      monthMinutes,
      monthlyExceeded: monthMinutes > 1200,
      nearMonthly,
    };
  }

  function renderLimitAlerts(node, entries, month) {
    if (!node) return;
    const result = limitCheck(entries, month);
    const alerts = [];
    result.daily.slice(0, 5).forEach((item) => {
      alerts.push(["하루 초과", `${item.date} · ${formatHours(item.minutes)} / 3시간`]);
    });
    result.weekly.slice(0, 5).forEach((item) => {
      alerts.push(["주간 초과", `${item.week} 주 · ${formatHours(item.minutes)} / 12시간`]);
    });
    if (result.monthlyExceeded) {
      alerts.push(["월간 초과", `${formatHours(result.monthMinutes)} / 20시간`]);
    } else if (result.nearMonthly) {
      alerts.push(["월간 임박", `${formatHours(result.monthMinutes)} / 20시간`]);
    }
    node.innerHTML = alerts.length ? `
      <div class="limit-alert-grid">
        ${alerts.map(([label, detail]) => `
          <div class="limit-alert">
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(detail)}</span>
          </div>
        `).join("")}
      </div>
    ` : '<div class="limit-ok">회사 제한시간 기준 초과 항목이 없습니다.</div>';
  }

  function renderWageSummary(entries) {
    const wage = Number($("#nightHourlyWage")?.value || state.settings.nightHourlyWage || 0);
    const paid = calculatePaidMinutes(entries);
    const estimate = (paid.monthlyPaidMinutes / 60) * wage;
    $("#wageSummary").innerHTML = `
      <div><span>실제 기록</span><strong>${escapeHtml(formatHours(paid.rawMinutes))}</strong></div>
      <div><span>하루 3시간 적용</span><strong>${escapeHtml(formatHours(paid.dailyCappedMinutes))}</strong></div>
      <div><span>주 12시간 / 월 20시간 적용</span><strong>${escapeHtml(formatHours(paid.monthlyPaidMinutes))}</strong></div>
      <div><span>예상 수당</span><strong>${escapeHtml(formatMoney(estimate))}</strong></div>
      <small>식비 기준은 회사 기준 확정 전이라 참고 계산에서 제외했습니다.</small>
    `;
  }

  function weekRangeLabel(start) {
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return `${start.getMonth() + 1}/${start.getDate()}~${end.getMonth() + 1}/${end.getDate()}`;
  }

  function renderWeeklySummary(node, entries, month) {
    const target = monthToDate(month);
    const first = new Date(target.getFullYear(), target.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    const weeks = [];
    for (let i = 0; i < 6; i += 1) {
      const weekStart = new Date(start);
      weekStart.setDate(start.getDate() + i * 7);
      weeks.push({ start: weekStart, minutes: 0, count: 0 });
    }
    entries.forEach((entry) => {
      const date = new Date(`${entry.date}T00:00:00`);
      const diff = Math.floor((date - start) / (7 * 24 * 60 * 60 * 1000));
      if (weeks[diff]) {
        weeks[diff].minutes += Number(entry.minutes || 0);
        weeks[diff].count += 1;
      }
    });
    const activeWeeks = weeks.filter((week) => week.count || monthKey(week.start) === month);
    node.innerHTML = activeWeeks.map((week) => `
      <div class="week-card">
        <span>${escapeHtml(weekRangeLabel(week.start))}</span>
        <strong>${escapeHtml(formatHours(week.minutes))}</strong>
        <small>${week.count}건</small>
      </div>
    `).join("");
  }

  function historySummary(entry) {
    const count = Array.isArray(entry.history) ? entry.history.length : 0;
    if (!count) return "";
    const last = entry.history[count - 1]?.editedAt || entry.updatedAt || "";
    return `수정 ${count}회${last ? ` · ${last.slice(0, 10)}` : ""}`;
  }

  function entriesTable(entries, options = {}) {
    const rows = entries.map((entry) => `
      <tr>
        ${options.selectable ? `<td><input class="row-check" type="checkbox" data-approval-select="${escapeHtml(entry.id)}" ${state.selectedApprovalIds.has(String(entry.id)) ? "checked" : ""}></td>` : ""}
        <td>${escapeHtml(entry.date || "")}</td>
        ${options.showRank ? `<td>${escapeHtml(employeeRankLabel(entry.employeeName))}</td>` : ""}
        <td>${escapeHtml(entry.employeeName || "")}</td>
        <td>${escapeHtml(entryTime(entry))}</td>
        <td>${escapeHtml(formatHours(entry.minutes))}</td>
        <td>${escapeHtml(entry.work || "")}</td>
        <td>${approvalStatusBadge(entry)}</td>
        ${options.approvalActions ? `<td>${approvalActionButton(entry)}</td>` : ""}
        <td>${escapeHtml(historySummary(entry))}</td>
        ${options.editable ? `<td><button class="icon-text edit-action" type="button" data-edit-entry="${escapeHtml(entry.id)}" data-edit-source="${escapeHtml(options.source || "mine")}">수정</button></td>` : ""}
        ${options.deletable ? `<td><button class="icon-text danger" type="button" data-delete-entry="${escapeHtml(entry.id)}" data-delete-source="${escapeHtml(options.source || "mine")}">삭제</button></td>` : ""}
      </tr>
    `).join("");
    const headers = ["날짜", "이름", "시간", "합계", "업무내용", "결재", "수정 이력"];
    if (options.showRank) headers.splice(1, 0, "직급");
    if (options.selectable) headers.unshift("");
    if (options.approvalActions) headers.splice(headers.length - 1, 0, "결재 처리");
    if (options.editable) headers.push("");
    if (options.deletable) headers.push("");
    return tableMarkup(rows, headers);
  }

  function approvalStatusBadge(entry) {
    const status = entry.approvalStatus || entry.approval?.status || "";
    const label = entry.approvalLabel || entry.approval?.label || "";
    if (!status && !label) return "";
    return `<span class="status-badge ${escapeHtml(status)}">${escapeHtml(label || status)}</span>`;
  }

  function approvalActionButton(entry) {
    const status = entry.approvalStatus || entry.approval?.status || "";
    const id = escapeHtml(entry.id || "");
    if (status === "submitted") {
      return `<button class="icon-text warning-action" type="button" data-approval-cancel-entry="${id}">올림 취소</button>`;
    }
    if (status === "approved") {
      return '<span class="status-badge approved">완료</span>';
    }
    return `<button class="icon-text edit-action" type="button" data-approval-submit-entry="${id}">결재 올림</button>`;
  }

  function rootFromEntryPath(pathValue) {
    const path = String(pathValue || "");
    const lower = path.toLowerCase();
    const markers = ["\\entries\\", "/entries/"];
    for (const marker of markers) {
      const index = lower.indexOf(marker);
      if (index >= 0) return path.slice(0, index);
    }
    return "";
  }

  function entryBaseFolder(entry, source) {
    if (source === "admin") {
      return entry.journalDir || rootFromEntryPath(entry.path) || "";
    }
    return currentBaseFolder();
  }

  function findEditableEntry(entryId, source) {
    const id = String(entryId || "");
    if (source === "admin") {
      const entry = state.adminEntries.find((item) => String(item.id) === id);
      return entry ? { entry, source: "admin" } : null;
    }
    const mine = state.myEntries.find((item) => String(item.id) === id);
    if (mine) return { entry: mine, source: "mine" };
    if (proxyModeEnabled()) {
      const admin = state.adminEntries.find((item) => String(item.id) === id);
      if (admin) return { entry: admin, source: "admin" };
    }
    return null;
  }

  function openEditDialog(entryId, source = "mine") {
    const target = findEditableEntry(entryId, source);
    if (!target) return;
    const { entry } = target;
    const baseFolder = entryBaseFolder(entry, target.source);
    if (!baseFolder) {
      setStatus("수정할 기록의 폴더 경로를 찾지 못했습니다.", "warn");
      return;
    }
    state.editContext = {
      source: target.source,
      baseFolder,
      employeeName: entry.employeeName || currentEmployeeName()
    };
    $("#editId").value = entry.id;
    $("#editDate").value = entry.date || "";
    $("#editStartTime").value = entry.startTime || "";
    $("#editEndTime").value = entry.endTime || "";
    $("#editWork").value = entry.work || "";
    renderEditHistory(entry);
    const dialog = $("#editDialog");
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeEditDialog() {
    const dialog = $("#editDialog");
    if (dialog.close && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    state.editContext = null;
  }

  function renderEditHistory(entry) {
    const history = Array.isArray(entry.history) ? entry.history : [];
    $("#editHistoryBox").innerHTML = history.length ? `
      <strong>수정 이력</strong>
      ${history.slice().reverse().map((item) => `
        <p>${escapeHtml((item.editedAt || "").slice(0, 19).replace("T", " "))}<br>
        ${escapeHtml(item.previous?.date || "")} ${escapeHtml(item.previous?.startTime || "")}~${escapeHtml(item.previous?.endTime || "")}
        → ${escapeHtml(item.current?.date || "")} ${escapeHtml(item.current?.startTime || "")}~${escapeHtml(item.current?.endTime || "")}</p>
      `).join("")}
    ` : '<div class="empty compact">아직 수정 이력이 없습니다.</div>';
  }

  async function saveEdit() {
    const id = $("#editId").value;
    const context = state.editContext || {
      source: "mine",
      baseFolder: currentBaseFolder(),
      employeeName: currentEmployeeName()
    };
    try {
      await request("/api/update", {
        baseFolder: context.baseFolder,
        id,
        employeeName: context.employeeName,
        entry: {
          date: $("#editDate").value,
          startTime: $("#editStartTime").value,
          endTime: $("#editEndTime").value,
          work: $("#editWork").value
        }
      });
      closeEditDialog();
      setStatus("수정 저장", "ok");
      if (context.source === "admin") await collectAdmin();
      else await loadMine();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function deleteEntry(entryId, source = "mine") {
    if (!entryId) return;
    if (source === "admin") {
      const target = findEditableEntry(entryId, "admin");
      if (!target) return;
      const baseFolder = entryBaseFolder(target.entry, "admin");
      if (!baseFolder) {
        setStatus("삭제할 기록의 폴더 경로를 찾지 못했습니다.", "warn");
        return;
      }
      if (!confirm(`${target.entry.employeeName || "직원"} 기록을 휴지통으로 이동할까요?`)) return;
      try {
        await request("/api/trash/delete", {
          baseFolder,
          id: entryId,
          deletedBy: currentEmployeeName()
        });
        await collectAdmin();
        setStatus("휴지통으로 이동", "ok");
      } catch (error) {
        setStatus(error.message, "warn");
      }
      return;
    }
    if (!currentBaseFolder()) return;
    if (!confirm("이 야근일지를 삭제할까요?")) return;
    try {
      await request("/api/delete", {
        baseFolder: currentBaseFolder(),
        id: entryId
      });
      setStatus("삭제 완료", "ok");
      await loadMine();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function groupEntriesByDay(entries) {
    return entries.reduce((map, entry) => {
      if (!map[entry.date]) map[entry.date] = [];
      map[entry.date].push(entry);
      return map;
    }, {});
  }

  function groupIssuesByDay(issues) {
    return (issues || []).reduce((map, issue) => {
      if (!map[issue.date]) map[issue.date] = [];
      map[issue.date].push(issue);
      return map;
    }, {});
  }

  function renderCalendarGrid(options) {
    const target = options.date;
    const year = target.getFullYear();
    const month = target.getMonth();
    const currentMonth = monthKey(target);
    const entries = filteredByMonth(options.entries, currentMonth).sort(compareEntriesByDateRankNameTime);
    const issues = visibleIssues(options.issues || [], currentMonth);
    const byDay = groupEntriesByDay(entries);
    const issueByDay = groupIssuesByDay(issues);
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dayKey(date);
      const dayEntries = byDay[key] || [];
      const dayIssues = issueByDay[key] || [];
      const minutes = dayEntries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
      const firstEntry = dayEntries[0];
      const preview = firstEntry
        ? options.mode === "admin"
          ? `${employeeDisplayName(firstEntry.employeeName)} ${shortWork(firstEntry.work, 14)}`
          : shortWork(firstEntry.work, 18)
        : "";
      const muted = date.getMonth() !== month ? " muted" : "";
      const selected = options.selectedDate === key ? " selected" : "";
      const hasEntry = dayEntries.length ? " has-entry" : "";
      const needsCheck = dayIssues.length ? " needs-check" : "";
      cells.push(`
        <button class="day${muted}${selected}${hasEntry}${needsCheck}" type="button" ${options.dateAttribute}="${key}">
          <span>${date.getDate()}</span>
          ${dayEntries.length ? `<strong>${escapeHtml(formatHours(minutes))}</strong>` : ""}
          ${preview ? `<small class="day-work">${escapeHtml(preview)}</small>` : ""}
          ${dayIssues.length ? `<em>확인 ${dayIssues.length}</em>` : ""}
        </button>
      `);
    }
    $(options.titleSelector).textContent = `${year}년 ${month + 1}월`;
    $(options.calendarSelector).innerHTML = `
      ${weekdays.map((day) => `<div class="weekday">${day}</div>`).join("")}
      ${cells.join("")}
    `;
  }

  function renderMyCalendar() {
    renderCalendarGrid({
      date: state.myCalendarDate,
      entries: state.myEntries,
      issues: state.attendanceReport.issues || [],
      selectedDate: state.selectedDate,
      titleSelector: "#myCalendarTitle",
      calendarSelector: "#myCalendar",
      dateAttribute: "data-my-date",
      mode: "mine"
    });
    renderSelectedDay();
  }

  function renderSelectedDay() {
    if (!state.selectedDate) {
      $("#selectedDayTitle").textContent = "날짜 선택";
      $("#selectedDayEntries").innerHTML = '<div class="empty">달력에서 날짜를 선택하세요.</div>';
      return;
    }
    const entries = state.myEntries
      .filter((entry) => entry.date === state.selectedDate)
      .sort(compareEntriesByDateRankNameTime);
    const issues = visibleIssues(state.attendanceReport.issues || [])
      .filter((issue) => issue.date === state.selectedDate)
      .sort(compareIssuesByDateRankNameTime);
    const minutes = entries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
    $("#selectedDayTitle").textContent = `${state.selectedDate} · ${formatHours(minutes)}`;
    const issueMarkup = issues.map((issue) => `
      <div class="mini-item warning">
        <span>${escapeHtml(issue.reason)} · 퇴근 ${escapeHtml(issue.roundedCheckOut || issue.lastCheckOut || "")}</span>
        <button class="icon-text edit-action" type="button" data-use-suggestion="${escapeHtml(issue.date)}">입력</button>
      </div>
    `).join("");
    const entryMarkup = entries.map((entry) => `
      <div class="mini-item">
        <span>${escapeHtml(entryTime(entry))} · ${escapeHtml(entry.work || "")} ${approvalStatusBadge(entry)}</span>
        <small>${escapeHtml(formatHours(entry.minutes))}</small>
        <div class="mini-actions">
          <button class="icon-text edit-action" type="button" data-edit-entry="${escapeHtml(entry.id)}">수정</button>
          <button class="icon-text danger" type="button" data-delete-entry="${escapeHtml(entry.id)}">삭제</button>
        </div>
      </div>
    `).join("");
    $("#selectedDayEntries").innerHTML = issueMarkup || entryMarkup
      ? `${issueMarkup}${entryMarkup}`
      : '<div class="empty">이 날짜에는 기록이 없습니다.</div>';
  }

  async function collectAdmin() {
    if (!collectFolders().length) {
      setStatus("수집 폴더가 없습니다.", "warn");
      return;
    }
    try {
      setStatus("수집 중");
      const payload = await request("/api/collect", { collectFolders: collectFolders() });
      state.adminEntries = payload.entries || [];
      state.warnings = payload.warnings || [];
      await loadAdminAttendanceData();
      renderAdmin();
      renderEmployeeStatus();
      await loadAdminTrash();
      setStatus(`${payload.count}건 수집`, state.warnings.length ? "warn" : "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function employeeStatusNames() {
    const names = new Set(selectedEmployees());
    state.adminEntries.forEach((entry) => {
      if (entry.employeeName) names.add(entry.employeeName);
    });
    return Array.from(names).filter(Boolean).sort(compareEmployeeByRankThenName);
  }

  function selectedStatusEmployee() {
    return $("#employeeStatusSelect")?.value || employeeStatusNames()[0] || "";
  }

  function renderEmployeeStatusSelector() {
    const select = $("#employeeStatusSelect");
    if (!select) return "";
    const current = select.value;
    const names = employeeStatusNames();
    select.innerHTML = names.length
      ? names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
      : '<option value="">직원 없음</option>';
    if (names.includes(current)) select.value = current;
    return select.value || names[0] || "";
  }

  function renderEmployeeStatus() {
    const selected = renderEmployeeStatusSelector();
    const month = $("#employeeMonth")?.value || todayMonth();
    const entries = state.adminEntries
      .filter((entry) => normalizeNameKey(entry.employeeName) === normalizeNameKey(selected))
      .sort(compareEntriesByDateRankNameTime);
    const monthEntries = filteredByMonth(entries, month).sort(compareEntriesByDateRankNameTime);
    const issues = visibleIssues(state.adminAttendanceReport.issues || [], month)
      .filter((issue) => normalizeNameKey(issue.employeeName) === normalizeNameKey(selected))
      .sort(compareIssuesByDateRankNameTime);
    if (!selected) {
      $("#employeeSummaryCards").innerHTML = "";
      $("#employeeIssueStrip").innerHTML = '<div class="empty compact">표시할 직원이 없습니다.</div>';
      $("#employeeLimitAlerts").innerHTML = "";
      $("#employeeWeeklySummary").innerHTML = "";
      $("#employeeEntriesTable").innerHTML = "";
      renderEmployeeCalendar([], []);
      return;
    }
    renderSummaryCards($("#employeeSummaryCards"), monthEntries, "mine");
    $("#employeeIssueStrip").innerHTML = issues.length
      ? `<div class="issue-card">${selected} · ${month} 확인 필요 ${issues.length}건</div>`
      : "";
    renderLimitAlerts($("#employeeLimitAlerts"), monthEntries, month);
    renderWeeklySummary($("#employeeWeeklySummary"), monthEntries, month);
    renderEmployeeCalendar(entries, issues);
    $("#employeeEntriesTable").innerHTML = monthEntries.length
      ? entriesTable(monthEntries, { approvalActions: true, editable: true, deletable: true, source: "admin", showRank: true })
      : '<div class="empty">이번 달 직원 기록이 없습니다.</div>';
  }

  function renderEmployeeCalendar(entries, issues) {
    renderCalendarGrid({
      date: state.employeeCalendarDate,
      entries,
      issues,
      selectedDate: state.employeeSelectedDate,
      titleSelector: "#employeeCalendarTitle",
      calendarSelector: "#employeeCalendar",
      dateAttribute: "data-employee-date",
      mode: "admin"
    });
    renderEmployeeSelectedDay(entries, issues);
  }

  function renderEmployeeSelectedDay(entries, issues) {
    if (!state.employeeSelectedDate) {
      $("#employeeSelectedDayTitle").textContent = "날짜 선택";
      $("#employeeSelectedDayEntries").innerHTML = '<div class="empty">직원 달력에서 날짜를 선택하세요.</div>';
      return;
    }
    const dayEntries = entries
      .filter((entry) => entry.date === state.employeeSelectedDate)
      .sort(compareEntriesByDateRankNameTime);
    const dayIssues = (issues || [])
      .filter((issue) => issue.date === state.employeeSelectedDate)
      .sort(compareIssuesByDateRankNameTime);
    const minutes = dayEntries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
    $("#employeeSelectedDayTitle").textContent = `${state.employeeSelectedDate} · ${formatHours(minutes)}`;
    const issueMarkup = dayIssues.map((issue) => `
      <div class="mini-item warning">
        <span>${escapeHtml(employeeRankLabel(issue.employeeName))} · ${escapeHtml(issue.reason)} · 퇴근 ${escapeHtml(issue.roundedCheckOut || issue.lastCheckOut || "")}</span>
        <small>확인 필요</small>
      </div>
    `).join("");
    const entryMarkup = dayEntries.map((entry) => `
      <div class="mini-item">
        <span>${escapeHtml(employeeRankLabel(entry.employeeName))} · ${escapeHtml(entryTime(entry))} · ${escapeHtml(entry.work || "")} ${approvalStatusBadge(entry)}</span>
        <small>${escapeHtml(formatHours(entry.minutes))}</small>
        <div class="mini-actions">
          ${approvalActionButton(entry)}
          <button class="icon-text edit-action" type="button" data-edit-entry="${escapeHtml(entry.id)}" data-edit-source="admin">수정</button>
          <button class="icon-text danger" type="button" data-delete-entry="${escapeHtml(entry.id)}" data-delete-source="admin">삭제</button>
        </div>
      </div>
    `).join("");
    $("#employeeSelectedDayEntries").innerHTML = issueMarkup || entryMarkup
      ? `${issueMarkup}${entryMarkup}`
      : '<div class="empty">이 날짜에는 직원 기록이 없습니다.</div>';
  }

  function adminEmployeeNames() {
    return Array.from(new Set(
      state.adminEntries
        .map((entry) => String(entry.employeeName || "").trim())
        .filter(Boolean)
    )).sort(compareEmployeeByRankThenName);
  }

  function renderAdminEmployeeFilter() {
    const select = $("#adminEmployeeFilter");
    const current = select.value;
    const names = adminEmployeeNames();
    select.innerHTML = [
      '<option value="">전체</option>',
      ...names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    ].join("");
    if (names.includes(current)) select.value = current;
  }

  async function createAdminBackup() {
    if (!collectFolders().length) {
      setStatus("수집 폴더가 없습니다.", "warn");
      return;
    }
    const employeeName = $("#adminEmployeeFilter").value;
    try {
      const payload = await request("/api/admin/backup", {
        collectFolders: collectFolders(),
        employeeName
      });
      $("#adminBackupStatus").textContent = `${employeeName || "전체"} 백업 ${payload.count || payload.availableCount || 0}건 · ${payload.path || ""}`;
      setStatus("관리자 백업 생성 완료", "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function restoreAdminBackup() {
    const employeeName = $("#adminEmployeeFilter").value;
    try {
      const file = await pickFile("", "복원할 관리자 백업 파일 선택");
      if (!file) return;
      const targetText = employeeName || "백업 파일 전체";
      if (!confirm(`${targetText} 기록 중 원래 위치에서 사라진 파일만 복원할까요?`)) return;
      const payload = await request("/api/admin/restore", {
        backupPath: file,
        employeeName
      });
      $("#adminBackupStatus").textContent = `복원 ${payload.restoredCount || 0}건 · 이미 있음 ${payload.skippedCount || 0}건 · 오류 ${payload.errorCount || 0}건`;
      setStatus("관리자 백업 복원 완료", payload.errorCount ? "warn" : "ok");
      await collectAdmin();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function loadAdminTrash() {
    if (!collectFolders().length) {
      state.adminTrash = [];
      renderAdminTrash();
      return;
    }
    try {
      const payload = await request("/api/trash/list", {
        collectFolders: collectFolders(),
        employeeName: $("#adminEmployeeFilter")?.value || ""
      });
      state.adminTrash = payload.items || [];
      renderAdminTrash(payload.warnings || []);
    } catch (error) {
      state.adminTrash = [];
      renderAdminTrash([{ message: error.message }]);
    }
  }

  function trashTime(item) {
    const text = String(item.deletedAt || "");
    return text ? text.slice(0, 19).replace("T", " ") : "";
  }

  function renderAdminTrash(warnings = []) {
    const table = $("#adminTrashTable");
    const count = $("#adminTrashCount");
    if (!table || !count) return;
    count.textContent = `${state.adminTrash.length}건`;
    const warningMarkup = warnings.length ? `
      <div class="error-list">
        ${warnings.map((warning) => `<p>${escapeHtml(warning.root || "")} ${escapeHtml(warning.message || "")}</p>`).join("")}
      </div>
    ` : "";
    if (!state.adminTrash.length) {
      table.innerHTML = `<div class="empty compact">휴지통이 비어 있습니다.</div>${warningMarkup}`;
      return;
    }
    const rows = state.adminTrash.map((item, index) => `
      <tr>
        <td>${escapeHtml(trashTime(item))}</td>
        <td>${escapeHtml(item.employeeName || "")}</td>
        <td>${escapeHtml(item.date || "")}</td>
        <td>${escapeHtml(entryTime(item))}</td>
        <td>${escapeHtml(item.work || "")}</td>
        <td>${escapeHtml(item.deletedBy || "")}</td>
        <td>
          <button class="icon-text edit-action" type="button" data-restore-trash="${index}">복원</button>
          <button class="icon-text danger" type="button" data-purge-trash="${index}">완전삭제</button>
        </td>
      </tr>
    `).join("");
    table.innerHTML = `${tableMarkup(rows, ["삭제일", "이름", "날짜", "시간", "업무내용", "삭제자", ""])}${warningMarkup}`;
  }

  async function restoreTrash(index) {
    const item = state.adminTrash[Number(index)];
    if (!item) return;
    if (!confirm(`${item.employeeName || "직원"} ${item.date || ""} 기록을 복원할까요?`)) return;
    try {
      await request("/api/trash/restore", {
        baseFolder: item.journalDir,
        trashPath: item.trashPath
      });
      await collectAdmin();
      setStatus("휴지통 기록 복원", "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function purgeTrash(index) {
    const item = state.adminTrash[Number(index)];
    if (!item) return;
    if (!confirm(`${item.employeeName || "직원"} ${item.date || ""} 휴지통 기록을 완전히 삭제할까요?`)) return;
    try {
      await request("/api/trash/purge", {
        baseFolder: item.journalDir,
        trashPath: item.trashPath
      });
      setStatus("휴지통 기록 완전삭제", "ok");
      await loadAdminTrash();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function selectedAdminEntries() {
    return state.adminEntries.filter((entry) => state.selectedApprovalIds.has(String(entry.id)));
  }

  function adminEntryById(entryId) {
    const id = String(entryId || "");
    return state.adminEntries.find((entry) => String(entry.id) === id);
  }

  async function updateApprovalEntries(entries, action) {
    if (!entries.length) {
      setStatus(action === "cancel" ? "올림 취소할 기록을 먼저 선택하세요." : "결재 올림 처리할 기록을 먼저 선택하세요.", "warn");
      return;
    }
    try {
      const payload = await request(action === "cancel" ? "/api/approval/cancel" : "/api/approval/submit", { entries });
      const label = action === "cancel" ? "결재 올림 취소" : "결재 올림";
      $("#approvalResult").innerHTML = `<div class="issue-card">${label} ${payload.updatedCount || 0}건 처리했습니다.</div>`;
      state.selectedApprovalIds.clear();
      await collectAdmin();
      setStatus(`${label} ${payload.updatedCount || 0}건`, "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function submitSelectedApproval() {
    await updateApprovalEntries(selectedAdminEntries(), "submit");
  }

  async function cancelSelectedApproval() {
    await updateApprovalEntries(selectedAdminEntries(), "cancel");
  }

  async function submitSingleApproval(entryId) {
    const entry = adminEntryById(entryId);
    if (!entry) return;
    await updateApprovalEntries([entry], "submit");
  }

  async function cancelSingleApproval(entryId) {
    const entry = adminEntryById(entryId);
    if (!entry) return;
    await updateApprovalEntries([entry], "cancel");
  }

  function renderApprovalCompareResult(payload) {
    const rows = [];
    (payload.approved || []).forEach((item) => {
      rows.push(`<tr><td>결재 완료</td><td>${escapeHtml(employeeRankLabel(item.record.employeeName))}</td><td>${escapeHtml(item.record.employeeName)}</td><td>${escapeHtml(item.record.date)}</td><td>${escapeHtml(item.record.startTime)}~${escapeHtml(item.record.endTime)}</td><td>일치</td></tr>`);
    });
    (payload.mismatches || []).forEach((item) => {
      rows.push(`<tr><td>시간 상이</td><td>${escapeHtml(employeeRankLabel(item.record.employeeName))}</td><td>${escapeHtml(item.record.employeeName)}</td><td>${escapeHtml(item.record.date)}</td><td>${escapeHtml(item.record.startTime)}~${escapeHtml(item.record.endTime)}</td><td>일지 ${escapeHtml(entryTime(item.entry))}</td></tr>`);
    });
    (payload.missingJournal || []).forEach((item) => {
      rows.push(`<tr><td>일지 누락</td><td>${escapeHtml(employeeRankLabel(item.record.employeeName))}</td><td>${escapeHtml(item.record.employeeName)}</td><td>${escapeHtml(item.record.date)}</td><td>${escapeHtml(item.record.startTime)}~${escapeHtml(item.record.endTime)}</td><td>수집 기록 없음</td></tr>`);
    });
    (payload.approvalMissing || []).slice(0, 200).forEach((item) => {
      rows.push(`<tr><td>결재 누락</td><td>${escapeHtml(employeeRankLabel(item.entry.employeeName))}</td><td>${escapeHtml(item.entry.employeeName)}</td><td>${escapeHtml(item.entry.date)}</td><td>${escapeHtml(entryTime(item.entry))}</td><td>결재 완료 목록에 없음</td></tr>`);
    });
    const errorMarkup = (payload.errors || []).length ? `
      <div class="error-list">
        ${payload.errors.map((error) => `<p><strong>${escapeHtml(error.line)}줄</strong> ${escapeHtml(error.message)} <span>${escapeHtml(error.text)}</span></p>`).join("")}
      </div>
    ` : "";
    $("#approvalResult").innerHTML = `
      <div class="summary-cards approval-cards">
        <div class="summary-card"><span>결재 완료</span><strong>${payload.approvedCount || 0}건</strong></div>
        <div class="summary-card"><span>시간 상이</span><strong>${payload.mismatchCount || 0}건</strong></div>
        <div class="summary-card"><span>일지 누락</span><strong>${payload.missingJournalCount || 0}건</strong></div>
        <div class="summary-card"><span>결재 누락</span><strong>${payload.approvalMissingCount || 0}건</strong></div>
      </div>
      ${rows.length ? tableMarkup(rows.join(""), ["상태", "직급", "이름", "날짜", "결재 시간", "비교"]) : '<div class="empty compact">비교 결과가 없습니다.</div>'}
      ${errorMarkup}
    `;
  }

  async function compareApprovalText() {
    if (!collectFolders().length) {
      setStatus("수집 폴더가 없습니다.", "warn");
      return;
    }
    const text = $("#approvalText").value;
    if (!text.trim()) {
      setStatus("결재 완료 목록을 붙여넣어 주세요.", "warn");
      return;
    }
    try {
      const payload = await request("/api/approval/compare", {
        collectFolders: collectFolders(),
        text
      });
      renderApprovalCompareResult(payload);
      setStatus("결재 완료 비교 완료", payload.errors?.length ? "warn" : "ok");
      await collectAdmin();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function loadAdminAttendanceData() {
    if (!attendanceFolders().length || !collectFolders().length) {
      state.adminAttendanceReport = { issues: [], records: [] };
      return;
    }
    state.adminAttendanceReport = await request("/api/attendance/report", {
      attendanceFolders: attendanceFolders(),
      collectFolders: collectFolders(),
      options: attendanceOptions()
    });
  }

  function renderAdmin() {
    const month = $("#adminMonth").value || todayMonth();
    const entries = filteredByMonth(state.adminEntries, month).sort(compareEntriesByDateRankNameTime);
    const issues = visibleIssues(state.adminAttendanceReport.issues || [], month).sort(compareIssuesByDateRankNameTime);
    renderAdminEmployeeFilter();
    renderSummaryCards($("#adminSummaryCards"), entries, "admin");
    $("#adminEntryCount").textContent = `${entries.length}건`;
    $("#exportCsvButton").disabled = entries.length === 0;
    renderAdminIssues(issues);

    const grouped = entries.reduce((map, entry) => {
      const name = entry.employeeName || "이름 없음";
      if (!map[name]) map[name] = { employeeName: name, minutes: 0, count: 0, days: new Set() };
      map[name].minutes += Number(entry.minutes || 0);
      map[name].count += 1;
      if (entry.date) map[name].days.add(entry.date);
      return map;
    }, {});
    const summaryRows = Object.values(grouped)
      .sort((a, b) => compareEmployeeByRankThenName(a.employeeName, b.employeeName))
      .map((item) => `
        <tr>
          <td>${escapeHtml(employeeRankLabel(item.employeeName))}</td>
          <td>${escapeHtml(item.employeeName)}</td>
          <td>${escapeHtml(formatHours(item.minutes))}</td>
          <td>${item.days.size}일</td>
          <td>${item.count}건</td>
        </tr>
      `).join("");
    const warningMarkup = state.warnings.length ? `
      <div class="error-list">
        ${state.warnings.map((warning) => `<p><strong>${escapeHtml(warning.root)}</strong> ${escapeHtml(warning.message)}</p>`).join("")}
      </div>
    ` : "";
    $("#adminSummaryTable").innerHTML = summaryRows
      ? `${tableMarkup(summaryRows, ["직급", "이름", "총 시간", "일수", "기록"])}${warningMarkup}`
      : `<div class="empty">수집된 기록이 없습니다.</div>${warningMarkup}`;
    $("#adminEntriesTable").innerHTML = entries.length
      ? entriesTable(entries, { selectable: true, approvalActions: true, editable: proxyModeEnabled(), deletable: proxyModeEnabled(), source: "admin", showRank: true })
      : '<div class="empty">수집된 원본 기록이 없습니다.</div>';
    renderAdminCalendar();
    renderAdminTrash();
  }

  function renderAdminIssues(issues) {
    if (!issues.length) {
      $("#adminIssuesTable").innerHTML = '<div class="empty compact">출퇴근 기록 기준 확인 필요 항목이 없습니다.</div>';
      return;
    }
    const rows = issues.map((issue) => `
      <tr>
        <td>${escapeHtml(issue.date)}</td>
        <td>${escapeHtml(employeeRankLabel(issue.employeeName))}</td>
        <td>${escapeHtml(issue.employeeName)}</td>
        <td>${escapeHtml(issue.firstCheckIn || "-")}</td>
        <td>${escapeHtml(issue.roundedCheckOut || issue.lastCheckOut || "-")}</td>
        <td>${escapeHtml(issue.reason)}</td>
      </tr>
    `).join("");
    $("#adminIssuesTable").innerHTML = `
      <div class="issue-card">확인 필요 ${issues.length}건</div>
      ${tableMarkup(rows, ["날짜", "직급", "이름", "출근", "퇴근", "내용"])}
    `;
  }

  function renderAdminCalendar() {
    renderCalendarGrid({
      date: state.adminCalendarDate,
      entries: state.adminEntries,
      issues: state.adminAttendanceReport.issues || [],
      selectedDate: state.adminSelectedDate,
      titleSelector: "#adminCalendarTitle",
      calendarSelector: "#adminCalendar",
      dateAttribute: "data-admin-date",
      mode: "admin"
    });
    renderAdminSelectedDay();
  }

  function renderAdminSelectedDay() {
    if (!state.adminSelectedDate) {
      $("#adminSelectedDayTitle").textContent = "날짜 선택";
      $("#adminSelectedDayEntries").innerHTML = '<div class="empty">전체 달력에서 날짜를 선택하세요.</div>';
      return;
    }
    const entries = state.adminEntries
      .filter((entry) => entry.date === state.adminSelectedDate)
      .sort(compareEntriesByDateRankNameTime);
    const issues = visibleIssues(state.adminAttendanceReport.issues || [])
      .filter((issue) => issue.date === state.adminSelectedDate)
      .sort(compareIssuesByDateRankNameTime);
    const minutes = entries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
    $("#adminSelectedDayTitle").textContent = `${state.adminSelectedDate} · ${formatHours(minutes)}`;
    const issueMarkup = issues.map((issue) => `
      <div class="mini-item warning">
        <span>${escapeHtml(employeeRankLabel(issue.employeeName))} · ${escapeHtml(issue.employeeName)} · ${escapeHtml(issue.reason)} · 퇴근 ${escapeHtml(issue.roundedCheckOut || issue.lastCheckOut || "")}</span>
        <small>확인 필요</small>
      </div>
    `).join("");
    const entryMarkup = entries.map((entry) => `
      <div class="mini-item">
        <span>${escapeHtml(employeeRankLabel(entry.employeeName))} · ${escapeHtml(entry.employeeName || "")} · ${escapeHtml(entryTime(entry))} · ${escapeHtml(entry.work || "")} ${approvalStatusBadge(entry)}</span>
        <small>${escapeHtml(formatHours(entry.minutes))}</small>
        ${proxyModeEnabled() ? `
          <div class="mini-actions">
            ${approvalActionButton(entry)}
            <button class="icon-text edit-action" type="button" data-edit-entry="${escapeHtml(entry.id)}" data-edit-source="admin">수정</button>
            <button class="icon-text danger" type="button" data-delete-entry="${escapeHtml(entry.id)}" data-delete-source="admin">삭제</button>
          </div>
        ` : `
          <div class="mini-actions">
            ${approvalActionButton(entry)}
          </div>
        `}
      </div>
    `).join("");
    $("#adminSelectedDayEntries").innerHTML = issueMarkup || entryMarkup
      ? `${issueMarkup}${entryMarkup}`
      : '<div class="empty">이 날짜에는 수집된 기록이 없습니다.</div>';
  }

  function exportCsv() {
    const month = $("#adminMonth").value || todayMonth();
    const entries = filteredByMonth(state.adminEntries, month).sort(compareEntriesByDateRankNameTime);
    const headers = ["날짜", "직급", "이름", "시작", "종료", "분", "시간", "수정이력", "업무내용", "파일경로"];
    const lines = [headers, ...entries.map((entry) => [
      entry.date || "",
      employeeRank(entry.employeeName) || "",
      entry.employeeName || "",
      entry.startTime || "",
      entry.endTime || "",
      entry.minutes || "",
      (Number(entry.minutes || 0) / 60).toFixed(2),
      historySummary(entry),
      entry.work || "",
      entry.path || ""
    ])].map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
    const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `야근일지_${month}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function shiftMonth(kind, diff) {
    if (kind === "mine") {
      state.myCalendarDate = new Date(state.myCalendarDate.getFullYear(), state.myCalendarDate.getMonth() + diff, 1);
      $("#recordsMonth").value = monthKey(state.myCalendarDate);
      state.selectedDate = "";
      renderMine();
      return;
    }
    if (kind === "employee") {
      state.employeeCalendarDate = new Date(state.employeeCalendarDate.getFullYear(), state.employeeCalendarDate.getMonth() + diff, 1);
      $("#employeeMonth").value = monthKey(state.employeeCalendarDate);
      state.employeeSelectedDate = "";
      renderEmployeeStatus();
      return;
    }
    state.adminCalendarDate = new Date(state.adminCalendarDate.getFullYear(), state.adminCalendarDate.getMonth() + diff, 1);
    $("#adminMonth").value = monthKey(state.adminCalendarDate);
    state.adminSelectedDate = "";
    renderAdmin();
  }

  function setTab(tab) {
    state.activeTab = tab;
    $$(".tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
    if (tab === "records") loadMine();
    if (tab === "employees") {
      if (!state.adminEntries.length && collectFolders().length) collectAdmin();
      else renderEmployeeStatus();
    }
    if (tab === "admin") {
      renderAdmin();
      loadAdminTrash();
    }
  }

  function bindEvents() {
    $("#settingsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await saveSettings();
        await loadMine();
      } catch (error) {
        setStatus(error.message, "warn");
      }
    });
    $("#attendanceOptionsForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await saveSettings();
        await refreshAttendanceViews();
      } catch (error) {
        setStatus(error.message, "warn");
      }
    });
    $("#pickDataRootFolder").addEventListener("click", chooseDataRootFolder);
    $("#createMyBackupButton").addEventListener("click", createMyBackup);
    $("#restoreMyBackupButton").addEventListener("click", restoreMyBackup);
    $("#refreshEmployeesButton").addEventListener("click", refreshDataRootEmployees);
    $("#addAttendanceFolder").addEventListener("click", () => addFolder("attendance"));
    $("#proxyCheckButton").addEventListener("click", checkProxyAttendance);
    $("#proxyDraftButton").addEventListener("click", createProxyDraft);
    $("#proxyModeEnabled").addEventListener("change", () => {
      state.parsedEntries = [];
      state.parseErrors = [];
      $("#saveParsedButton").disabled = true;
      $("#previewCount").textContent = "0건";
      $("#proxyStatus").textContent = proxyModeEnabled()
        ? "대리 입력 모드: 직원 이름 줄 아래 야근일지를 적어 저장합니다."
        : "직원 이름 줄 아래에 해당 직원 야근일지를 적으면 직원별 폴더로 저장됩니다.";
      renderAdmin();
    });
    $("#sampleButton").addEventListener("click", () => {
      $("#quickText").value = sampleText;
      parseQuickText();
    });
    $("#checkAttendanceButton").addEventListener("click", async () => {
      try {
        await loadMyAttendanceData();
        renderMine();
        renderSuggestionPane();
        setStatus("출퇴근 확인 완료", "ok");
      } catch (error) {
        setStatus(error.message, "warn");
      }
    });
    $("#parseButton").addEventListener("click", parseQuickText);
    $("#saveParsedButton").addEventListener("click", saveParsedEntries);
    $("#reloadMine").addEventListener("click", loadMine);
    $("#saveWageButton").addEventListener("click", async () => {
      try {
        await saveSettings();
        renderMine();
      } catch (error) {
        setStatus(error.message, "warn");
      }
    });
    $("#recordsMonth").addEventListener("change", () => {
      state.myCalendarDate = monthToDate($("#recordsMonth").value);
      state.selectedDate = "";
      renderMine();
    });
    $("#employeeMonth").addEventListener("change", () => {
      state.employeeCalendarDate = monthToDate($("#employeeMonth").value);
      state.employeeSelectedDate = "";
      renderEmployeeStatus();
    });
    $("#employeeStatusSelect").addEventListener("change", () => {
      state.employeeSelectedDate = "";
      renderEmployeeStatus();
    });
    $("#reloadEmployees").addEventListener("click", collectAdmin);
    $("#adminMonth").addEventListener("change", () => {
      state.adminCalendarDate = monthToDate($("#adminMonth").value);
      state.adminSelectedDate = "";
      renderAdmin();
    });
    $("#collectButton").addEventListener("click", collectAdmin);
    $("#adminBackupButton").addEventListener("click", createAdminBackup);
    $("#adminRestoreButton").addEventListener("click", restoreAdminBackup);
    $("#refreshTrashButton").addEventListener("click", loadAdminTrash);
    $("#adminEmployeeFilter").addEventListener("change", loadAdminTrash);
    $("#submitApprovalButton").addEventListener("click", submitSelectedApproval);
    $("#cancelApprovalButton").addEventListener("click", cancelSelectedApproval);
    $("#compareApprovalButton").addEventListener("click", compareApprovalText);
    $("#exportCsvButton").addEventListener("click", exportCsv);
    $("#quickPrevMonth").addEventListener("click", () => {
      state.quickCalendarDate = new Date(state.quickCalendarDate.getFullYear(), state.quickCalendarDate.getMonth() - 1, 1);
      renderQuickCalendar();
    });
    $("#quickNextMonth").addEventListener("click", () => {
      state.quickCalendarDate = new Date(state.quickCalendarDate.getFullYear(), state.quickCalendarDate.getMonth() + 1, 1);
      renderQuickCalendar();
    });
    $("#prevMonth").addEventListener("click", () => shiftMonth("mine", -1));
    $("#nextMonth").addEventListener("click", () => shiftMonth("mine", 1));
    $("#employeePrevMonth").addEventListener("click", () => shiftMonth("employee", -1));
    $("#employeeNextMonth").addEventListener("click", () => shiftMonth("employee", 1));
    $("#adminPrevMonth").addEventListener("click", () => shiftMonth("admin", -1));
    $("#adminNextMonth").addEventListener("click", () => shiftMonth("admin", 1));
    $("#editForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveEdit();
    });
    $("#closeEditDialog").addEventListener("click", closeEditDialog);
    $("#cancelEditButton").addEventListener("click", closeEditDialog);
    $$(".tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
    document.addEventListener("click", (event) => {
      const proxyIssueButton = event.target.closest("[data-proxy-issue-index]");
      if (proxyIssueButton) {
        insertProxyIssue(proxyIssueButton.dataset.proxyIssueIndex);
        return;
      }
      const quickDateButton = event.target.closest("[data-quick-date]");
      if (quickDateButton) {
        insertDateTemplate(quickDateButton.dataset.quickDate);
        return;
      }
      const insertButton = event.target.closest("[data-insert-text]");
      if (insertButton) {
        insertQuickText(insertButton.dataset.insertText);
        return;
      }
      const myDay = event.target.closest("[data-my-date]");
      if (myDay) {
        state.selectedDate = myDay.dataset.myDate;
        renderMyCalendar();
        return;
      }
      const adminDay = event.target.closest("[data-admin-date]");
      if (adminDay) {
        state.adminSelectedDate = adminDay.dataset.adminDate;
        renderAdminCalendar();
        return;
      }
      const employeeDay = event.target.closest("[data-employee-date]");
      if (employeeDay) {
        state.employeeSelectedDate = employeeDay.dataset.employeeDate;
        renderEmployeeStatus();
        return;
      }
      const deleteButton = event.target.closest("[data-delete-entry]");
      if (deleteButton) {
        deleteEntry(deleteButton.dataset.deleteEntry, deleteButton.dataset.deleteSource || "mine");
        return;
      }
      const restoreTrashButton = event.target.closest("[data-restore-trash]");
      if (restoreTrashButton) {
        restoreTrash(restoreTrashButton.dataset.restoreTrash);
        return;
      }
      const purgeTrashButton = event.target.closest("[data-purge-trash]");
      if (purgeTrashButton) {
        purgeTrash(purgeTrashButton.dataset.purgeTrash);
        return;
      }
      const approvalSubmitButton = event.target.closest("[data-approval-submit-entry]");
      if (approvalSubmitButton) {
        submitSingleApproval(approvalSubmitButton.dataset.approvalSubmitEntry);
        return;
      }
      const approvalCancelButton = event.target.closest("[data-approval-cancel-entry]");
      if (approvalCancelButton) {
        cancelSingleApproval(approvalCancelButton.dataset.approvalCancelEntry);
        return;
      }
      const editButton = event.target.closest("[data-edit-entry]");
      if (editButton) {
        openEditDialog(editButton.dataset.editEntry, editButton.dataset.editSource || "mine");
        return;
      }
      const removeButton = event.target.closest("[data-remove-folder]");
      if (removeButton) {
        removeFolder(removeButton.dataset.removeFolder, removeButton.dataset.folderIndex);
        return;
      }
      const suggestionButton = event.target.closest("[data-use-suggestion]");
      if (suggestionButton) {
        useSuggestion(suggestionButton.dataset.useSuggestion);
      }
    });
    document.addEventListener("change", (event) => {
      const rankSelect = event.target.closest("[data-employee-rank]");
      if (rankSelect) {
        const name = rankSelect.dataset.employeeRank || "";
        state.settings.employeeRanks = { ...(state.settings.employeeRanks || {}) };
        if (rankSelect.value) state.settings.employeeRanks[name] = rankSelect.value;
        else delete state.settings.employeeRanks[name];
        renderAdmin();
        renderEmployeeStatus();
        return;
      }
      const employeeCheckbox = event.target.closest("[data-employee-select]");
      if (employeeCheckbox) {
        const name = employeeCheckbox.dataset.employeeSelect || "";
        const current = new Set(selectedEmployees().map((item) => normalizeNameKey(item)));
        const next = selectedEmployees().filter((item) => normalizeNameKey(item) !== normalizeNameKey(name));
        if (employeeCheckbox.checked && !current.has(normalizeNameKey(name))) next.push(name);
        state.settings.selectedEmployees = next;
        renderEmployeePicker();
        return;
      }
      const checkbox = event.target.closest("[data-approval-select]");
      if (!checkbox) return;
      const id = String(checkbox.dataset.approvalSelect || "");
      if (checkbox.checked) state.selectedApprovalIds.add(id);
      else state.selectedApprovalIds.delete(id);
    });
  }

  async function init() {
    startClientLifecycle();
    $("#recordsMonth").value = todayMonth();
    $("#employeeMonth").value = todayMonth();
    $("#adminMonth").value = todayMonth();
    state.myCalendarDate = monthToDate(todayMonth());
    state.employeeCalendarDate = monthToDate(todayMonth());
    state.adminCalendarDate = monthToDate(todayMonth());
    state.quickCalendarDate = monthToDate(todayMonth());
    bindEvents();
    await loadSettings();
    await loadMine();
    renderQuickCalendar();
    renderAdmin();
  }

  init();
})();

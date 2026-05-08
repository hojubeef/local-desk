(function () {
  const apiBase = location.protocol === "http:" ? "" : "http://127.0.0.1:8765";
  const sampleText = `2026.05.06(수) 18:00~20:00
2026년도 하수도 맨홀추락방지시설 설치공사(3차) 도면 작업

2026.05.07(목) 18:30~21:00
상수도 급수공사 수량산출서 정리`;

  const state = {
    settings: {},
    parsedEntries: [],
    parseErrors: [],
    myEntries: [],
    adminEntries: [],
    calendarDate: new Date(),
    selectedDate: "",
    activeTab: "quick"
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setStatus(message, tone) {
    const box = $("#statusBox");
    box.textContent = message;
    box.dataset.tone = tone || "";
  }

  async function request(path, body, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      method: options.method || (body === undefined ? "GET" : "POST"),
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

  function todayMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function dayKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

  function currentEmployeeName() {
    return $("#employeeName").value.trim();
  }

  function currentBaseFolder() {
    return $("#baseFolder").value.trim();
  }

  function currentAdminRoot() {
    return $("#adminRoot").value.trim();
  }

  function filteredByMonth(entries, month) {
    return entries.filter((entry) => entryMonth(entry) === month);
  }

  function summarize(entries) {
    const totalMinutes = entries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
    const days = new Set(entries.map((entry) => entry.date)).size;
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
      <div class="overtime-summary-card">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(value)}</strong>
      </div>
    `).join("");
  }

  function renderSettings(settings) {
    state.settings = settings || {};
    $("#employeeName").value = state.settings.employeeName || "";
    $("#baseFolder").value = state.settings.baseFolder || "";
    $("#adminRoot").value = state.settings.adminRoot || "";
    $("#journalDirText").textContent = state.settings.journalDir || "-";
  }

  async function loadSettings() {
    try {
      const payload = await request("/api/overtime/settings");
      renderSettings(payload.settings);
      setStatus("준비 완료", "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function saveSettings() {
    const payload = await request("/api/overtime/settings", {
      employeeName: currentEmployeeName(),
      baseFolder: currentBaseFolder(),
      adminRoot: currentAdminRoot()
    });
    renderSettings(payload.settings);
    setStatus("설정을 저장했습니다.", "ok");
  }

  async function pickFolder(input, title) {
    try {
      const payload = await request("/api/overtime/select-folder", {
        initialDir: input.value,
        title
      });
      if (!payload.cancelled && payload.folder) {
        input.value = payload.folder;
        setStatus("폴더를 선택했습니다.");
      }
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function parseQuickText() {
    const text = $("#quickText").value;
    if (!text.trim()) {
      setStatus("붙여넣을 내용이 없습니다.", "warn");
      return;
    }
    try {
      const payload = await request("/api/overtime/parse", {
        text,
        employeeName: currentEmployeeName()
      });
      state.parsedEntries = payload.entries || [];
      state.parseErrors = payload.errors || [];
      renderPreview();
      $("#saveParsedButton").disabled = state.parsedEntries.length === 0;
      setStatus(`${state.parsedEntries.length}건을 인식했습니다.`, state.parseErrors.length ? "warn" : "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
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
      <div class="overtime-error-list">
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
      ${rows ? `
        <div class="overtime-table-scroll">
          <table class="preview-table">
            <thead>
              <tr>
                <th>#</th>
                <th>날짜</th>
                <th>시간</th>
                <th>합계</th>
                <th>업무내용</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : ""}
      ${errors}
    `;
  }

  async function saveParsedEntries() {
    if (!currentEmployeeName()) {
      setStatus("이름을 먼저 입력해주세요.", "warn");
      return;
    }
    if (!currentBaseFolder()) {
      setStatus("저장 폴더를 먼저 선택해주세요.", "warn");
      return;
    }
    if (!state.parsedEntries.length) {
      setStatus("저장할 항목이 없습니다.", "warn");
      return;
    }
    try {
      const payload = await request("/api/overtime/save", {
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
      setStatus(`${payload.count}건 저장 완료`, "ok");
      await loadMine();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  async function loadMine() {
    if (!currentBaseFolder()) {
      state.myEntries = [];
      renderMine();
      return;
    }
    try {
      const payload = await request("/api/overtime/list", { baseFolder: currentBaseFolder() });
      state.myEntries = payload.entries || [];
      $("#journalDirText").textContent = payload.journalDir || state.settings.journalDir || "-";
      renderMine();
      renderCalendar();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function renderMine() {
    const month = $("#recordsMonth").value || todayMonth();
    const entries = filteredByMonth(state.myEntries, month);
    renderSummaryCards($("#mySummaryCards"), entries, "mine");
    $("#myEntriesTable").innerHTML = entries.length ? entriesTable(entries, { deletable: true }) : '<div class="empty">이번 달 기록이 없습니다.</div>';
  }

  function entriesTable(entries, options = {}) {
    const rows = entries.map((entry) => `
      <tr>
        <td>${escapeHtml(entry.date || "")}</td>
        <td>${escapeHtml(entry.employeeName || "")}</td>
        <td>${escapeHtml(entryTime(entry))}</td>
        <td>${escapeHtml(formatHours(entry.minutes))}</td>
        <td>${escapeHtml(entry.work || "")}</td>
        ${options.deletable ? `<td><button class="text-button tiny" type="button" data-delete-entry="${escapeHtml(entry.id)}">삭제</button></td>` : ""}
      </tr>
    `).join("");
    return `
      <div class="overtime-table-scroll">
        <table class="preview-table">
          <thead>
            <tr>
              <th>날짜</th>
              <th>이름</th>
              <th>시간</th>
              <th>합계</th>
              <th>업무내용</th>
              ${options.deletable ? "<th></th>" : ""}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  async function deleteEntry(entryId) {
    if (!entryId || !currentBaseFolder()) return;
    if (!confirm("이 야근일지를 삭제할까요?")) return;
    try {
      await request("/api/overtime/delete", {
        baseFolder: currentBaseFolder(),
        id: entryId
      });
      setStatus("삭제했습니다.", "ok");
      await loadMine();
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function renderCalendar() {
    const target = state.calendarDate;
    const year = target.getFullYear();
    const month = target.getMonth();
    const currentMonth = monthKey(target);
    const entries = filteredByMonth(state.myEntries, currentMonth);
    const byDay = entries.reduce((map, entry) => {
      if (!map[entry.date]) map[entry.date] = [];
      map[entry.date].push(entry);
      return map;
    }, {});
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dayKey(date);
      const dayEntries = byDay[key] || [];
      const minutes = dayEntries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
      const muted = date.getMonth() !== month ? " muted" : "";
      const selected = state.selectedDate === key ? " selected" : "";
      const hasEntry = dayEntries.length ? " has-entry" : "";
      cells.push(`
        <button class="overtime-day${muted}${selected}${hasEntry}" type="button" data-calendar-date="${key}">
          <span>${date.getDate()}</span>
          ${dayEntries.length ? `<strong>${formatHours(minutes)}</strong><small>${dayEntries.length}건</small>` : ""}
        </button>
      `);
    }
    $("#calendarTitle").textContent = `${year}년 ${month + 1}월`;
    $("#overtimeCalendar").innerHTML = `
      ${["일", "월", "화", "수", "목", "금", "토"].map((day) => `<div class="overtime-weekday">${day}</div>`).join("")}
      ${cells.join("")}
    `;
    renderSelectedDay();
  }

  function renderSelectedDay() {
    if (!state.selectedDate) {
      $("#selectedDayTitle").textContent = "날짜 선택";
      $("#selectedDayEntries").innerHTML = '<div class="empty">달력에서 날짜를 선택하세요.</div>';
      return;
    }
    const entries = state.myEntries.filter((entry) => entry.date === state.selectedDate);
    const minutes = entries.reduce((sum, entry) => sum + Number(entry.minutes || 0), 0);
    $("#selectedDayTitle").textContent = `${state.selectedDate} · ${formatHours(minutes)}`;
    $("#selectedDayEntries").innerHTML = entries.length
      ? entries.map((entry) => `
          <div class="mini-item overtime-day-entry">
            <span>${escapeHtml(entryTime(entry))} · ${escapeHtml(entry.work || "")}</span>
            <small>${escapeHtml(formatHours(entry.minutes))}</small>
          </div>
        `).join("")
      : '<div class="empty">이 날짜에는 기록이 없습니다.</div>';
  }

  async function collectAdmin() {
    if (!currentAdminRoot()) {
      setStatus("관리자 수집 폴더를 입력해주세요.", "warn");
      return;
    }
    try {
      setStatus("직원 폴더를 수집하는 중...");
      const payload = await request("/api/overtime/collect", { root: currentAdminRoot() });
      state.adminEntries = payload.entries || [];
      renderAdmin();
      setStatus(`${payload.count}건을 수집했습니다.`, "ok");
    } catch (error) {
      setStatus(error.message, "warn");
    }
  }

  function renderAdmin() {
    const month = $("#adminMonth").value || todayMonth();
    const entries = filteredByMonth(state.adminEntries, month);
    renderSummaryCards($("#adminSummaryCards"), entries, "admin");
    $("#adminEntryCount").textContent = `${entries.length}건`;
    $("#exportCsvButton").disabled = entries.length === 0;

    const grouped = entries.reduce((map, entry) => {
      const name = entry.employeeName || "이름 없음";
      if (!map[name]) map[name] = { employeeName: name, minutes: 0, count: 0, days: new Set() };
      map[name].minutes += Number(entry.minutes || 0);
      map[name].count += 1;
      if (entry.date) map[name].days.add(entry.date);
      return map;
    }, {});
    const summaryRows = Object.values(grouped)
      .sort((a, b) => b.minutes - a.minutes)
      .map((item) => `
        <tr>
          <td>${escapeHtml(item.employeeName)}</td>
          <td>${escapeHtml(formatHours(item.minutes))}</td>
          <td>${item.days.size}일</td>
          <td>${item.count}건</td>
        </tr>
      `).join("");
    $("#adminSummaryTable").innerHTML = summaryRows ? `
      <div class="overtime-table-scroll compact">
        <table class="preview-table">
          <thead><tr><th>이름</th><th>총 시간</th><th>일수</th><th>기록</th></tr></thead>
          <tbody>${summaryRows}</tbody>
        </table>
      </div>
    ` : '<div class="empty">수집된 기록이 없습니다.</div>';
    $("#adminEntriesTable").innerHTML = entries.length ? entriesTable(entries) : '<div class="empty">수집된 원본 기록이 없습니다.</div>';
  }

  function exportCsv() {
    const month = $("#adminMonth").value || todayMonth();
    const entries = filteredByMonth(state.adminEntries, month);
    const headers = ["날짜", "이름", "시작", "종료", "분", "시간", "업무내용", "파일경로"];
    const lines = [headers, ...entries.map((entry) => [
      entry.date || "",
      entry.employeeName || "",
      entry.startTime || "",
      entry.endTime || "",
      entry.minutes || "",
      (Number(entry.minutes || 0) / 60).toFixed(2),
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

  function setTab(tab) {
    state.activeTab = tab;
    $$(".overtime-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    $$(".overtime-tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
    if (tab === "records") loadMine();
    if (tab === "calendar") {
      loadMine().then(renderCalendar);
    }
    if (tab === "admin") renderAdmin();
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
    $("#pickBaseFolder").addEventListener("click", () => pickFolder($("#baseFolder"), "내 웹하드/공유드라이브 폴더 선택"));
    $("#pickAdminRoot").addEventListener("click", () => pickFolder($("#adminRoot"), "직원 웹하드 상위 폴더 선택"));
    $("#sampleButton").addEventListener("click", () => {
      $("#quickText").value = sampleText;
      parseQuickText();
    });
    $("#parseButton").addEventListener("click", parseQuickText);
    $("#saveParsedButton").addEventListener("click", saveParsedEntries);
    $("#reloadMine").addEventListener("click", loadMine);
    $("#recordsMonth").addEventListener("change", renderMine);
    $("#adminMonth").addEventListener("change", renderAdmin);
    $("#collectButton").addEventListener("click", collectAdmin);
    $("#exportCsvButton").addEventListener("click", exportCsv);
    $("#prevOvertimeMonth").addEventListener("click", () => {
      state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() - 1, 1);
      renderCalendar();
    });
    $("#nextOvertimeMonth").addEventListener("click", () => {
      state.calendarDate = new Date(state.calendarDate.getFullYear(), state.calendarDate.getMonth() + 1, 1);
      renderCalendar();
    });
    $$(".overtime-tab").forEach((button) => button.addEventListener("click", () => setTab(button.dataset.tab)));
    document.addEventListener("click", (event) => {
      const day = event.target.closest("[data-calendar-date]");
      if (day) {
        state.selectedDate = day.dataset.calendarDate;
        renderCalendar();
        return;
      }
      const deleteButton = event.target.closest("[data-delete-entry]");
      if (deleteButton) {
        deleteEntry(deleteButton.dataset.deleteEntry);
      }
    });
  }

  async function init() {
    $("#recordsMonth").value = todayMonth();
    $("#adminMonth").value = todayMonth();
    state.calendarDate = new Date(`${todayMonth()}-01T00:00:00`);
    bindEvents();
    await loadSettings();
    await loadMine();
  }

  init();
})();

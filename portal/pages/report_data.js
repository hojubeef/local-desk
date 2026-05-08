(function () {
  const apiBase = location.protocol === "http:" ? "" : "http://127.0.0.1:8765";
  const fallbackRegions = {
    "전국": ["전체"],
    "서울특별시": ["전체", "종로구", "중구", "강남구", "송파구"],
    "경상북도": ["전체", "포항시", "경주시", "김천시", "안동시", "구미시", "상주시"],
    "경기도": ["전체", "수원시", "성남시", "고양시", "용인시"],
    "부산광역시": ["전체", "중구", "서구", "동구", "해운대구"]
  };

  let regions = fallbackRegions;
  let catalog = null;
  let currentReport = null;
  let selectedItemId = "";
  let itemStates = {};
  let recommendationRuns = {};
  let previewRuns = {};
  let currentPreviewKey = "";

  const $ = (selector) => document.querySelector(selector);

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

  function updateApiUsage(usage) {
    const snapshot = usage || {};
    const recent = Number(snapshot.recent_calls || 0);
    const limit = Number(snapshot.rate_limit_per_minute || 1000);
    const session = Number(snapshot.session_calls || 0);
    const total = Number(snapshot.total_calls || 0);
    const percent = Math.min(100, Number(snapshot.usage_percent || 0));

    $("#apiRecent").textContent = `${recent}/${limit}회`;
    $("#apiSession").textContent = `${session}회`;
    $("#apiTotal").textContent = `${total}회`;
    $("#apiMeterFill").style.width = `${percent}%`;
  }

  async function request(path, options) {
    const response = await fetch(`${apiBase}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    if (!response.ok || (data && data.error)) {
      throw new Error((data && data.error) || `요청 실패 (${response.status})`);
    }
    return data;
  }

  function getReport(reportId) {
    return (catalog?.reports || []).find((report) => report.id === reportId) || null;
  }

  function getItem(itemId) {
    return (currentReport?.items || []).find((item) => item.id === itemId) || null;
  }

  function itemState(itemId) {
    if (!itemStates[itemId]) {
      itemStates[itemId] = { status: "pending", selectedCandidate: null };
    }
    return itemStates[itemId];
  }

  function candidateKey(candidate) {
    return `${candidate.orgId || ""}:${candidate.tableId || ""}`;
  }

  function criteriaBody(itemId) {
    return {
      reportId: $("#reportSelect").value,
      itemId,
      sido: $("#sidoSelect").value,
      sigungu: $("#sigunguSelect").value || "전체",
      reportYear: $("#reportYearInput").value.trim(),
      yearWindow: $("#yearWindowSelect").value,
      maxCandidates: 5
    };
  }

  function regionName() {
    const sigungu = $("#sigunguSelect").value || "전체";
    return sigungu !== "전체" ? sigungu : $("#sidoSelect").value;
  }

  function periodRange() {
    const reportYear = Number($("#reportYearInput").value || 0);
    const yearWindow = Number($("#yearWindowSelect").value || 5);
    if (!reportYear) {
      return { start: "", end: "" };
    }
    return {
      start: String(reportYear - Math.max(1, yearWindow) + 1),
      end: String(reportYear)
    };
  }

  function fillSelect(select, values, selectedValue) {
    select.innerHTML = values
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join("");
    if (selectedValue && values.includes(selectedValue)) {
      select.value = selectedValue;
    }
  }

  function populateRegions() {
    const sidoNames = Object.keys(regions);
    fillSelect($("#sidoSelect"), sidoNames, "경상북도");
    updateSigunguOptions("상주시");
  }

  function updateSigunguOptions(selectedValue) {
    const values = regions[$("#sidoSelect").value] || ["전체"];
    fillSelect($("#sigunguSelect"), values, selectedValue || values[0]);
  }

  function populateReports() {
    const options = (catalog?.reports || [])
      .map((report) => `<option value="${escapeHtml(report.id)}">${escapeHtml(report.name)}</option>`)
      .join("");
    $("#reportSelect").innerHTML = options;
    currentReport = getReport($("#reportSelect").value);
    renderCurrentReport();
  }

  function resetWorkflow() {
    itemStates = {};
    recommendationRuns = {};
    previewRuns = {};
    selectedItemId = "";
    currentPreviewKey = "";
    $("#previewPane").innerHTML = '<div class="empty">후보 통계표에서 미리보기를 실행하세요.</div>';
    $("#previewTitle").textContent = "자료 확인";
    $("#previewRowCount").textContent = "";
  }

  function renderCurrentReport() {
    currentReport = getReport($("#reportSelect").value);
    resetWorkflow();
    renderItemList();
    renderDetail();
    $("#recommendAllButton").disabled = !currentReport;
    $("#exportWorkbookButton").disabled = !currentReport;
    $("#itemPanelTitle").textContent = currentReport ? currentReport.name : "기초자료 리스트";
  }

  function statusText(status) {
    return {
      pending: "대기",
      searching: "검색 중",
      ready: "후보 있음",
      selected: "사용",
      excluded: "제외",
      manual: "수동"
    }[status] || "대기";
  }

  function statusClass(status) {
    return `report-data-status-${status || "pending"}`;
  }

  function renderItemList() {
    const items = currentReport?.items || [];
    $("#itemCount").textContent = `${items.length}개`;
    if (!items.length) {
      $("#itemList").innerHTML = '<div class="empty">보고서를 선택하세요.</div>';
      return;
    }

    $("#itemList").innerHTML = items.map((item) => {
      const state = itemState(item.id);
      const run = recommendationRuns[item.id];
      const candidate = state.selectedCandidate;
      const topCandidate = run?.candidates?.[0];
      const summary = candidate
        ? `${candidate.title} · ${candidate.agency || "기관 미확인"}`
        : topCandidate
          ? `${topCandidate.title} · ${topCandidate.sourceLabel}`
          : item.description;
      const active = selectedItemId === item.id ? " active" : "";
      return `
        <article class="report-data-item${active}" data-item-id="${escapeHtml(item.id)}">
          <div class="report-data-item-main">
            <div>
              <h3>${escapeHtml(item.name)}</h3>
              <p>${escapeHtml(summary)}</p>
            </div>
            <span class="report-data-status ${statusClass(state.status)}">${escapeHtml(statusText(state.status))}</span>
          </div>
          <div class="report-data-keywords">
            ${(item.keywords || []).slice(0, 4).map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("")}
          </div>
          <div class="report-data-row-actions">
            <button class="text-button tiny" type="button" data-action="recommend" data-item-id="${escapeHtml(item.id)}">후보 찾기</button>
            <button class="text-button tiny" type="button" data-action="manual" data-item-id="${escapeHtml(item.id)}">수동</button>
            <button class="text-button tiny" type="button" data-action="exclude" data-item-id="${escapeHtml(item.id)}">제외</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function selectedItemOrFirst() {
    if (selectedItemId) {
      return getItem(selectedItemId);
    }
    return currentReport?.items?.[0] || null;
  }

  function renderDetail() {
    const item = selectedItemOrFirst();
    if (!item) {
      $("#detailTitle").textContent = "항목 선택";
      $("#candidateCount").textContent = "";
      $("#detailPane").innerHTML = '<div class="empty">기초자료 항목을 선택하세요.</div>';
      return;
    }
    selectedItemId = item.id;
    const state = itemState(item.id);
    const run = recommendationRuns[item.id];
    const candidates = run?.candidates || [];
    $("#detailTitle").textContent = item.name;
    $("#candidateCount").textContent = candidates.length ? `${candidates.length}건` : "";

    if (state.status === "searching") {
      $("#detailPane").innerHTML = '<div class="empty">후보를 찾는 중입니다...</div>';
      return;
    }

    if (!run) {
      $("#detailPane").innerHTML = `
        <div class="report-data-detail-intro">
          <p>${escapeHtml(item.description)}</p>
          <p>자동추천은 선택 시/군 기관별 통계와 상하수도 주요기관 통계만 확인합니다.</p>
          <button class="primary-button small" type="button" data-action="recommend" data-item-id="${escapeHtml(item.id)}">이 항목 후보 찾기</button>
        </div>
      `;
      return;
    }

    if (!candidates.length) {
      $("#detailPane").innerHTML = `
        <div class="empty">
          ${escapeHtml(run.message || "후보가 없습니다.")}
          <div class="report-data-empty-actions">
            <button class="text-button" type="button" data-action="manual" data-item-id="${escapeHtml(item.id)}">수동 검색 필요로 표시</button>
          </div>
        </div>
      `;
      return;
    }

    $("#detailPane").innerHTML = `
      <div class="report-data-source-plan">
        ${(run.searchPlan || []).map((source) => `<span>${escapeHtml(source.rank)}. ${escapeHtml(source.label)}</span>`).join("")}
      </div>
      <div class="report-data-candidate-list">
        ${candidates.map((candidate, index) => candidateCard(candidate, index, state.selectedCandidate)).join("")}
      </div>
    `;
  }

  function candidateCard(candidate, index, selectedCandidate) {
    const selected = selectedCandidate && candidateKey(selectedCandidate) === candidateKey(candidate);
    const selectedClass = selected ? " selected" : "";
    const yearLabel = candidate.yearCheck?.label || candidate.latest || "";
    return `
      <article class="report-data-candidate${selectedClass}">
        <div class="report-data-candidate-head">
          <div>
            <p class="section-label">${escapeHtml(candidate.sourceLabel || "후보")} · ${escapeHtml(candidate.reportGrade || "검토")}</p>
            <h3>${escapeHtml(candidate.title || "통계표명 없음")}</h3>
          </div>
          <strong>${escapeHtml(candidate.reportScore || 0)}</strong>
        </div>
        <dl class="report-data-meta-list">
          <div><dt>기관</dt><dd>${escapeHtml(candidate.agency || "미확인")}</dd></div>
          <div><dt>기간</dt><dd>${escapeHtml(candidate.period || candidate.latest || "미확인")}</dd></div>
          <div><dt>기준연도</dt><dd>${escapeHtml(yearLabel || "미확인")}</dd></div>
          <div><dt>검색어</dt><dd>${escapeHtml(candidate.matchedKeyword || "")}</dd></div>
        </dl>
        <p class="report-data-reason">${escapeHtml(candidate.reportReason || candidate.reason || "")}</p>
        <div class="report-data-row-actions">
          <button class="primary-button small" type="button" data-action="preview" data-item-id="${escapeHtml(selectedItemId)}" data-candidate-index="${index}">미리보기</button>
          <button class="text-button tiny" type="button" data-action="select-candidate" data-item-id="${escapeHtml(selectedItemId)}" data-candidate-index="${index}">사용</button>
        </div>
      </article>
    `;
  }

  async function recommendItem(itemId) {
    const item = getItem(itemId);
    if (!item) return;
    selectedItemId = itemId;
    itemState(itemId).status = "searching";
    renderItemList();
    renderDetail();
    setStatus(`${item.name} 후보 검색 중...`);

    try {
      const payload = await request("/api/report-data/recommend", {
        method: "POST",
        body: JSON.stringify(criteriaBody(itemId))
      });
      recommendationRuns[itemId] = payload;
      itemState(itemId).status = payload.candidates?.length ? "ready" : "manual";
      updateApiUsage(payload.apiUsage);
      setStatus(`${item.name}: 후보 ${payload.candidates?.length || 0}건`, payload.candidates?.length ? "ok" : "warn");
    } catch (error) {
      recommendationRuns[itemId] = { candidates: [], message: error.message };
      itemState(itemId).status = "manual";
      setStatus(error.message, "warn");
    }
    renderItemList();
    renderDetail();
  }

  async function recommendAll() {
    const items = currentReport?.items || [];
    if (!items.length) return;
    const button = $("#recommendAllButton");
    button.disabled = true;
    button.textContent = "전체 검색 중...";
    for (let index = 0; index < items.length; index += 1) {
      setStatus(`전체 후보 검색 중... (${index + 1}/${items.length}) ${items[index].name}`);
      await recommendItem(items[index].id);
    }
    button.disabled = false;
    button.textContent = "전체 후보 찾기";
    setStatus("전체 후보 검색 완료", "ok");
  }

  function selectCandidate(itemId, candidateIndex) {
    const run = recommendationRuns[itemId];
    const candidate = run?.candidates?.[Number(candidateIndex)];
    if (!candidate) return;
    const state = itemState(itemId);
    state.status = "selected";
    state.selectedCandidate = candidate;
    selectedItemId = itemId;
    renderItemList();
    renderDetail();
    setStatus(`${getItem(itemId)?.name || "항목"} 자료를 사용으로 표시했습니다.`, "ok");
  }

  function markManual(itemId) {
    const state = itemState(itemId);
    state.status = "manual";
    state.selectedCandidate = null;
    selectedItemId = itemId;
    renderItemList();
    renderDetail();
    setStatus(`${getItem(itemId)?.name || "항목"}을 수동 검색 필요로 표시했습니다.`, "warn");
  }

  function markExcluded(itemId) {
    const state = itemState(itemId);
    state.status = "excluded";
    state.selectedCandidate = null;
    selectedItemId = itemId;
    renderItemList();
    renderDetail();
    setStatus(`${getItem(itemId)?.name || "항목"}을 제외했습니다.`);
  }

  function objectSelectionBody() {
    const selections = {};
    document.querySelectorAll("[data-object-select]").forEach((select) => {
      const objId = select.dataset.objectSelect;
      if (!objId) return;
      selections[objId] = select.value || "ALL";
    });
    return selections;
  }

  function renderPreviewControls(candidate, optionsPayload) {
    const options = optionsPayload.options || {};
    const period = options.period || {};
    const range = periodRange();
    const startValue = range.start || period.start || "";
    const endValue = range.end || period.end || "";
    const itemOptions = (options.items || [{ id: "ALL", name: "전체" }])
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.id)}</option>`)
      .join("");
    const objectControls = (options.objects || []).map((group) => {
      const selected = group.selected?.id || "ALL";
      const values = [{ id: "ALL", name: "전체" }, ...(group.values || [])];
      return `
        <label>
          <span>${escapeHtml(group.obj_name || group.obj_id || "분류")}</span>
          <select data-object-select="${escapeHtml(group.obj_id || "")}">
            ${values.map((value) => `<option value="${escapeHtml(value.id)}" ${value.id === selected ? "selected" : ""}>${escapeHtml(value.name || value.id)}</option>`).join("")}
          </select>
        </label>
      `;
    }).join("");
    const summaries = (options.summaries || [])
      .map((summary) => `<p>${escapeHtml(summary)}</p>`)
      .join("");

    $("#previewPane").innerHTML = `
      <div class="report-data-preview-controls">
        <div>
          <p class="section-label">선택 자료</p>
          <h3>${escapeHtml(candidate.title)}</h3>
          <p>${escapeHtml(candidate.agency || "")} · ${escapeHtml(candidate.sourceLabel || "")}</p>
        </div>
        <div class="report-data-control-grid">
          <label>
            <span>항목</span>
            <select id="previewItemSelect">${itemOptions}</select>
          </label>
          <label>
            <span>시작시점</span>
            <input id="previewStartPeriod" type="text" value="${escapeHtml(startValue)}" placeholder="예: 2020">
          </label>
          <label>
            <span>종료시점</span>
            <input id="previewEndPeriod" type="text" value="${escapeHtml(endValue)}" placeholder="예: 2024">
          </label>
          <label>
            <span>최근 개수</span>
            <input id="previewLatestCount" type="number" min="1" max="50" value="5">
          </label>
          ${objectControls}
        </div>
        <div class="report-data-option-summary">${summaries}</div>
        <div class="report-data-row-actions">
          <button class="primary-button small" type="button" data-action="run-preview">자료 조회</button>
          <button class="text-button tiny" type="button" data-action="select-current-preview">이 자료 사용</button>
        </div>
        <div class="report-data-preview-table" id="previewTableArea">
          <div class="empty">조건을 확인한 뒤 자료 조회를 누르세요.</div>
        </div>
      </div>
    `;
  }

  async function previewCandidate(itemId, candidateIndex) {
    const run = recommendationRuns[itemId];
    const candidate = run?.candidates?.[Number(candidateIndex)];
    if (!candidate) return;
    selectedItemId = itemId;
    currentPreviewKey = `${itemId}:${candidateKey(candidate)}`;
    $("#previewTitle").textContent = getItem(itemId)?.name || "자료 확인";
    $("#previewRowCount").textContent = "";
    $("#previewPane").innerHTML = '<div class="empty">선택 조건을 불러오는 중...</div>';
    setStatus("자료 선택지를 불러오는 중...");

    try {
      const optionsPayload = await request("/api/kosis/options", {
        method: "POST",
        body: JSON.stringify({
          orgId: candidate.orgId,
          tableId: candidate.tableId,
          regionName: regionName()
        })
      });
      previewRuns[currentPreviewKey] = {
        itemId,
        candidate,
        optionsPayload,
        payload: null,
        selections: null
      };
      updateApiUsage(optionsPayload.apiUsage);
      renderPreviewControls(candidate, optionsPayload);
      setStatus("미리보기 조건을 확인하세요.", "ok");
    } catch (error) {
      $("#previewPane").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
      setStatus(error.message, "warn");
    }
  }

  async function runPreview() {
    const preview = previewRuns[currentPreviewKey];
    if (!preview) return;
    const candidate = preview.candidate;
    const body = {
      orgId: candidate.orgId,
      tableId: candidate.tableId,
      regionName: regionName(),
      itemIds: $("#previewItemSelect")?.value || "ALL",
      latestCount: $("#previewLatestCount")?.value || "5",
      startPeriod: $("#previewStartPeriod")?.value.trim() || "",
      endPeriod: $("#previewEndPeriod")?.value.trim() || "",
      objectSelections: objectSelectionBody()
    };
    $("#previewTableArea").innerHTML = '<div class="empty">자료 조회 중...</div>';
    setStatus("자료 조회 중...");

    try {
      const payload = await request("/api/kosis/preview", {
        method: "POST",
        body: JSON.stringify(body)
      });
      preview.payload = payload;
      preview.selections = body;
      updateApiUsage(payload.apiUsage);
      renderPreviewTable(payload);
      $("#previewRowCount").textContent = `${payload.displayedRows || 0}/${payload.rowCount || 0}행`;
      setStatus(`자료 조회 완료: ${payload.rowCount || 0}행`, "ok");
    } catch (error) {
      $("#previewTableArea").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
      setStatus(error.message, "warn");
    }
  }

  function renderPreviewTable(payload) {
    const columns = payload.columns || [];
    const rows = payload.rows || [];
    if (!columns.length || !rows.length) {
      $("#previewTableArea").innerHTML = '<div class="empty">조회된 행이 없습니다.</div>';
      return;
    }
    $("#previewTableArea").innerHTML = `
      <div class="preview-table-meta">화면에는 최대 300행까지 표시됩니다.</div>
      <div class="preview-table-scroll">
        <table class="preview-table">
          <thead>
            <tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>${columns.map((col) => `<td>${escapeHtml(row[col])}</td>`).join("")}</tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  function selectCurrentPreview() {
    const preview = previewRuns[currentPreviewKey];
    if (!preview) return;
    selectCandidate(preview.itemId, (recommendationRuns[preview.itemId]?.candidates || []).findIndex(
      (candidate) => candidateKey(candidate) === candidateKey(preview.candidate)
    ));
  }

  function exportWorkbook() {
    if (!window.XLSX) {
      setStatus("SheetJS 로딩 후 다시 시도해주세요.", "warn");
      return;
    }
    const workbook = XLSX.utils.book_new();
    const items = currentReport?.items || [];
    const summaryRows = items.map((item, index) => {
      const state = itemState(item.id);
      const candidate = state.selectedCandidate || {};
      return {
        순번: index + 1,
        보고서: currentReport?.name || "",
        지역: `${$("#sidoSelect").value} ${$("#sigunguSelect").value || "전체"}`.trim(),
        기준연도: $("#reportYearInput").value || "",
        항목: item.name,
        상태: statusText(state.status),
        통계표명: candidate.title || "",
        기관명: candidate.agency || "",
        통계표ID: candidate.tableId || "",
        기관ID: candidate.orgId || "",
        추천출처: candidate.sourceLabel || "",
        추천점수: candidate.reportScore || "",
        수록기간: candidate.period || "",
        비고: item.description || ""
      };
    });
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "선택요약");

    Object.values(previewRuns).forEach((preview, index) => {
      if (!preview.payload || !preview.payload.rows?.length) return;
      const item = getItem(preview.itemId);
      const sheetName = `${String(index + 1).padStart(2, "0")}_${(item?.name || "자료").slice(0, 20)}`.replace(/[\\/?*[\]:]/g, " ");
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(preview.payload.rows), sheetName.slice(0, 31));
    });

    const manualRows = items
      .filter((item) => ["manual", "excluded"].includes(itemState(item.id).status))
      .map((item) => ({
        항목: item.name,
        상태: statusText(itemState(item.id).status),
        추천검색어: item.searchKeyword || "",
        키워드: (item.keywords || []).join(", "),
        설명: item.description || ""
      }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(manualRows), "수동_제외");
    const fileName = `보고서_기초자료_${currentReport?.shortName || "report"}_${regionName()}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(workbook, fileName);
    setStatus("Excel 파일을 만들었습니다.", "ok");
  }

  async function init() {
    setStatus("서버 확인 중...");
    try {
      const data = await request("/api/report-data/catalog");
      catalog = data.catalog;
      regions = data.regions || fallbackRegions;
      $("#catalogNote").textContent = catalog.note || "";
      populateRegions();
      populateReports();
      setStatus("준비 완료", "ok");
    } catch (error) {
      catalog = { reports: [] };
      regions = fallbackRegions;
      populateRegions();
      setStatus(error.message, "warn");
      $("#itemList").innerHTML = '<div class="empty">로컬 서버 연결을 확인해주세요.</div>';
    }
  }

  $("#sidoSelect").addEventListener("change", () => updateSigunguOptions());
  $("#reportSelect").addEventListener("change", renderCurrentReport);
  $("#reportDataForm").addEventListener("submit", (event) => {
    event.preventDefault();
    renderCurrentReport();
    setStatus("조건을 적용했습니다.", "ok");
  });
  $("#recommendAllButton").addEventListener("click", recommendAll);
  $("#exportWorkbookButton").addEventListener("click", exportWorkbook);

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const itemCard = event.target.closest(".report-data-item");
    if (itemCard && !button) {
      selectedItemId = itemCard.dataset.itemId;
      renderItemList();
      renderDetail();
      return;
    }
    if (!button) return;
    const action = button.dataset.action;
    const itemId = button.dataset.itemId || selectedItemId;
    if (action === "recommend") recommendItem(itemId);
    if (action === "manual") markManual(itemId);
    if (action === "exclude") markExcluded(itemId);
    if (action === "select-candidate") selectCandidate(itemId, button.dataset.candidateIndex);
    if (action === "preview") previewCandidate(itemId, button.dataset.candidateIndex);
    if (action === "run-preview") runPreview();
    if (action === "select-current-preview") selectCurrentPreview();
  });

  init();
})();

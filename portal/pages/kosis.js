(function () {
  const apiBase = location.protocol === "http:" ? "" : "http://127.0.0.1:8765";
  const localServerMessage = "로컬 서버에 연결할 수 없습니다. scripts\\Local Desk 실행.bat로 열어주세요.";
  const launcherPath = "C:\\Users\\fusro\\Desktop\\kosis\\Local Desk 실행.bat";
  const cacheKeyPrefix = "localDesk.kosis.search.";
  const cacheIndexKey = "localDesk.kosis.search.index";
  const cacheLimit = 12;
  const fallbackRegions = {
    "전국": ["전체"],
    "서울특별시": ["전체", "종로구", "중구", "강남구", "송파구"],
    "경상북도": ["전체", "포항시", "경주시", "김천시", "안동시", "구미시", "상주시"],
    "경기도": ["전체", "수원시", "성남시", "고양시", "용인시"],
    "부산광역시": ["전체", "중구", "서구", "동구", "해운대구"]
  };

  let regions = fallbackRegions;
  let currentPayload = null;
  let flatTables = [];
  let selectedIndex = -1;
  let currentTable = null;
  let currentDataOptions = null;
  let conditionState = { itemIds: [], objects: {} };
  let expandedConditionNodes = new Set();
  let optionLoadToken = 0;

  // 피벗 설정 상태
  let pivotConfig = { rows: [], cols: [], values: [], fields: [] };
  let lastPreviewPayload = null;

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

  function setServerHelpVisible(visible) {
    $("#serverHelp").hidden = !visible;
  }

  function setSearchLog(lines) {
    const values = Array.isArray(lines) ? lines : [lines];
    $("#searchLog").innerHTML = values
      .filter(Boolean)
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("");
  }

  function formatClock(value) {
    return new Intl.DateTimeFormat("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(value);
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

  function updateSearchProgress(progress, message) {
    const percent = Math.max(0, Math.min(100, Number(progress || 0)));
    $("#searchProgressPercent").textContent = `${Math.round(percent)}%`;
    $("#searchProgressFill").style.width = `${percent}%`;
    $("#searchProgressMessage").textContent = message || "검색 대기 중";
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  function stableSearchBody(body) {
    return {
      sido: body.sido,
      sigungu: body.sigungu,
      keyword: body.keyword,
      includeSubregionSearch: Boolean(body.includeSubregionSearch),
      reportYear: String(body.reportYear || ""),
      yearWindow: String(body.yearWindow || "5"),
      customYearWindow: String(body.customYearWindow || ""),
      includeLatestData: Boolean(body.includeLatestData)
    };
  }

  function searchCacheKey(body) {
    return `${cacheKeyPrefix}${JSON.stringify(stableSearchBody(body))}`;
  }

  function readCachedSearch(body) {
    return readJson(searchCacheKey(body), null);
  }

  function writeCachedSearch(body, payload) {
    const key = searchCacheKey(body);
    const entry = {
      savedAt: Date.now(),
      body: stableSearchBody(body),
      payload
    };
    if (!writeJson(key, entry)) {
      return false;
    }

    const index = readJson(cacheIndexKey, []).filter((item) => item.key !== key);
    index.unshift({
      key,
      savedAt: entry.savedAt,
      title: `${body.sido} ${body.sigungu} ${body.keyword}`.trim()
    });
    for (const stale of index.slice(cacheLimit)) {
      localStorage.removeItem(stale.key);
    }
    writeJson(cacheIndexKey, index.slice(0, cacheLimit));
    return true;
  }

  function cachedAtText(value) {
    return new Intl.DateTimeFormat("ko-KR", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }

  async function pollSearchJob(jobId, startedAt, body) {
    while (true) {
      const job = await request(`/api/kosis/search/status?id=${encodeURIComponent(jobId)}`);
      updateSearchProgress(job.progress, job.message);
      if (job.apiUsage) {
        updateApiUsage(job.apiUsage);
      }
      setSearchLog([
        `${formatClock(startedAt)} 검색 시작`,
        `${body.sido} ${body.sigungu} / ${body.keyword}`,
        `${job.progress || 0}% · ${job.message || "검색 중..."}`
      ]);

      if (job.status === "done") {
        return job.result;
      }
      if (job.status === "error") {
        throw new Error(job.error || job.message || "검색 실패");
      }
      await delay(450);
    }
  }

  function supportsLegacySearch(error) {
    const message = String(error?.message || "");
    return message.includes("Unknown API endpoint") || message.includes("검색 작업을 찾을 수 없습니다");
  }

  async function runLegacySearch(body) {
    updateSearchProgress(12, "구버전 서버 감지. 기존 검색 방식으로 진행 중...");
    const payload = await request("/api/kosis/search", {
      method: "POST",
      body: JSON.stringify(body)
    });
    updateSearchProgress(100, `검색 완료: ${payload.total || 0}건`);
    return payload;
  }

  async function request(path, options) {
    let response;
    try {
      response = await fetch(`${apiBase}${path}`, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
    } catch (error) {
      throw new Error(localServerMessage);
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new Error("서버 응답을 읽지 못했습니다. Local Desk 실행 창을 확인해주세요.");
    }

    if (!response.ok) {
      throw new Error(data.error || "요청 실패");
    }
    return data;
  }

  async function loadRegions() {
    try {
      const data = await request("/api/kosis/regions");
      regions = data.regions || fallbackRegions;
      setStatus("준비 완료", "ok");
      setServerHelpVisible(false);
      setSearchLog("검색 대기 중");
    } catch (error) {
      regions = fallbackRegions;
      setStatus(localServerMessage, "warn");
      setServerHelpVisible(true);
      setSearchLog("Local Desk 실행 파일로 다시 열면 KOSIS 검색을 사용할 수 있습니다.");
    }
    renderSidoOptions();
  }

  function renderSidoOptions() {
    const select = $("#sidoSelect");
    const names = Object.keys(regions);
    select.innerHTML = names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (names.includes("경상북도")) {
      select.value = "경상북도";
    }
    renderSigunguOptions();
  }

  function renderSigunguOptions() {
    const sido = $("#sidoSelect").value;
    const values = regions[sido] || ["전체"];
    $("#sigunguSelect").innerHTML = values
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join("");
    if (values.includes("상주시")) {
      $("#sigunguSelect").value = "상주시";
    }
  }

  function currentRegionName() {
    const sigungu = $("#sigunguSelect").value;
    if (sigungu && sigungu !== "전체") {
      return sigungu;
    }
    return $("#sidoSelect").value;
  }

  function gradeClass(grade) {
    if (grade === "높음") return "high";
    if (grade === "낮음") return "low";
    return "mid";
  }

  function yearStatusClass(status) {
    if (status === "contains") return "contains";
    if (status === "window") return "window";
    if (status === "old" || status === "missing") return "old";
    if (status === "future") return "future";
    return "unknown";
  }

  function renderYearBadges(check) {
    if (!check) return "";
    const badges = [
      `<span class="year-status ${yearStatusClass(check.status)}">${escapeHtml(check.label)}</span>`,
      `<span>기준 ${escapeHtml(check.rangeLabel)}</span>`
    ];
    if (check.hasRecentAfterReportYear) {
      badges.push(`<span>최신 ${escapeHtml(check.fetchEndYear)}까지</span>`);
    }
    return badges.join("");
  }

  function renderYearDetail(check) {
    if (!check) return "";
    const period = check.periodStartYear && check.periodEndYear
      ? `${check.periodStartYear}~${check.periodEndYear}`
      : "기간 미확인";
    const latestText = check.hasRecentAfterReportYear
      ? `최신자료 포함 시 ${check.fetchRangeLabel}까지 조회 예정`
      : `조회 기준 기간 ${check.fetchRangeLabel}`;

    return `
      <section class="year-detail-box">
        <h3 class="mini-heading">기준년도 판정</h3>
        <div class="detail-kv">
          <span>수록연도</span><strong>${escapeHtml(period)}</strong>
          <span>기준년도</span><strong>${escapeHtml(check.reportYear)}</strong>
          <span>기준기간</span><strong>${escapeHtml(check.rangeLabel)} (${escapeHtml(check.windowYears)}년)</strong>
          <span>판정</span><strong>${escapeHtml(check.label)}</strong>
          <span>자료조회</span><strong>${escapeHtml(latestText)}</strong>
        </div>
      </section>
    `;
  }

  function renderDataQueryShell(table) {
    const check = table.yearCheck || {};
    const startPeriod = check.fetchStartYear || "";
    const endPeriod = check.fetchEndYear || "";
    const periodHint = check.fetchRangeLabel
      ? `기준 기간 기본값: ${check.fetchRangeLabel}`
      : "기간을 비워두면 최근 N개 자료를 조회합니다.";

    return `
      <section class="data-query-panel">
        <div class="data-query-head">
          <div>
            <h3 class="mini-heading">자료 조회 조건</h3>
            <p id="dataOptionStatus">조건 메타를 불러오는 중...</p>
          </div>
          <button class="primary-button small" type="button" id="previewDataButton" disabled>자료 미리보기</button>
        </div>
        <div class="period-type-row">
          <span class="period-type-label">수록주기</span>
          <span id="periodTypeInfo" hidden>불러오는 중...</span>
        </div>
        <div class="preview-period-row">
          <label>
            <span>시작기간</span>
            <input id="previewStartPeriod" type="text" value="${escapeHtml(startPeriod)}" placeholder="예: 2020">
          </label>
          <label>
            <span>종료기간</span>
            <input id="previewEndPeriod" type="text" value="${escapeHtml(endPeriod)}" placeholder="예: 2024">
          </label>
          <label>
            <span>최근</span>
            <input id="previewLatestCount" type="number" min="1" max="50" value="5">
          </label>
        </div>
        <p class="condition-hint">${escapeHtml(periodHint)}</p>
        <div class="condition-summary" id="conditionSummary">조건 선택 대기 중</div>
        <div class="condition-tree" id="conditionTree">
          <div class="empty">조건 메타를 불러오는 중...</div>
        </div>
        <div class="preview-status" id="previewStatus"></div>
      </section>
    `;
  }

  function defaultConditionState(options) {
    const items = options.items || [];
    const state = {
      itemIds: [items[0]?.id || "ALL"],
      objects: {}
    };
    for (const group of options.objects || []) {
      const objId = group.obj_id;
      state.objects[objId] = [group.selected?.id || "ALL"];
    }
    return state;
  }

  function buildValueTree(values) {
    const byId = new Map(values.map((value) => [String(value.id || ""), value]));
    const children = new Map();
    const roots = [];
    for (const value of values) {
      const id = String(value.id || "");
      const upId = String(value.up_id || "");
      if (upId && byId.has(upId)) {
        if (!children.has(upId)) children.set(upId, []);
        children.get(upId).push(value);
      } else {
        roots.push(value);
      }
      if (!children.has(id)) children.set(id, []);
    }
    return { roots, children };
  }

  function descendantIds(values, valueId) {
    const tree = buildValueTree(values);
    const found = [];
    function visit(id) {
      for (const child of tree.children.get(String(id)) || []) {
        found.push(child.id);
        visit(child.id);
      }
    }
    visit(valueId);
    return found;
  }

  function isChecked(kind, objId, valueId) {
    if (kind === "item") {
      return conditionState.itemIds.includes(valueId);
    }
    return (conditionState.objects[objId] || ["ALL"]).includes(valueId);
  }

  function domIdPart(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  function conditionNodeKey(objId, valueId) {
    return `${objId}::${valueId}`;
  }

  function isConditionNodeExpanded(objId, valueId) {
    return expandedConditionNodes.has(conditionNodeKey(objId, valueId));
  }

  function selectionTags(values, totalCount) {
    const shown = values.slice(0, 2);
    const tags = shown.map((value) => `<span class="condition-selection-tag">${escapeHtml(value)}</span>`);
    if (totalCount > shown.length) {
      tags.push(`<span class="condition-selection-tag muted">+${totalCount - shown.length}</span>`);
    }
    return `<span class="condition-selection-tags">${tags.join("")}</span>`;
  }

  function itemSelectionTags(items) {
    const selected = conditionState.itemIds || [];
    if (selected.includes("ALL")) {
      return selectionTags(["전체"], 1);
    }
    const byId = new Map(items.map((item) => [String(item.id || ""), item]));
    const names = selected.map((id) => byId.get(String(id))?.name || id);
    return selectionTags(names, selected.length);
  }

  function objectSelectionTags(group) {
    const selected = conditionState.objects[group.obj_id] || ["ALL"];
    if (selected.includes("ALL")) {
      return selectionTags(["전체"], 1);
    }
    const byId = new Map((group.values || []).map((value) => [String(value.id || ""), value]));
    const names = selected.map((id) => byId.get(String(id))?.name || id);
    return selectionTags(names, selected.length);
  }

  function renderValueRows(values, objId, valueList, depth = 0) {
    return valueList.map((value) => {
      const id = String(value.id || "");
      const children = values.children.get(id) || [];
      const expanded = isConditionNodeExpanded(objId, id);
      const nodeKey = conditionNodeKey(objId, id);
      const inputId = `condition-object-${domIdPart(objId)}-${domIdPart(id)}`;
      return `
        <div class="condition-row" style="--depth:${depth}" data-node-key="${escapeHtml(nodeKey)}">
          ${children.length
            ? `<button class="condition-toggle ${expanded ? "expanded" : ""}" type="button" aria-label="하위 목록 열기" data-condition-action="toggle-node" data-obj-id="${escapeHtml(objId)}" data-value-id="${escapeHtml(id)}"><span></span></button>`
            : '<span class="condition-toggle-spacer"></span>'}
          <input id="${escapeHtml(inputId)}" class="condition-check" type="checkbox" data-kind="object" data-obj-id="${escapeHtml(objId)}" data-value-id="${escapeHtml(id)}" ${isChecked("object", objId, id) ? "checked" : ""}>
          <label for="${escapeHtml(inputId)}">${escapeHtml(value.name)}</label>
          <code>${escapeHtml(id)}</code>
        </div>
        ${children.length && expanded ? renderValueRows(values, objId, children, depth + 1) : ""}
      `;
    }).join("");
  }

  function revealConditionNode(treeNode, focus) {
    if (!focus?.nodeKey) return;
    const row = Array.from(treeNode.querySelectorAll("[data-node-key]"))
      .find((node) => node.dataset.nodeKey === focus.nodeKey);
    const target = focus.revealChildren ? row?.nextElementSibling || row : row;
    target?.scrollIntoView({ block: "nearest" });
  }

  function renderConditionTree(options, focus) {
    const treeNode = $("#conditionTree");
    const treeScrollTop = treeNode?.scrollTop || 0;
    const items = options.items || [];
    const itemRows = items.slice(0, 300).map((item) => {
      const inputId = `condition-item-${domIdPart(item.id)}`;
      return `
      <div class="condition-row" style="--depth:0">
        <span class="condition-toggle-spacer"></span>
        <input id="${escapeHtml(inputId)}" class="condition-check" type="checkbox" data-kind="item" data-value-id="${escapeHtml(item.id)}" ${isChecked("item", "", item.id) ? "checked" : ""}>
        <label for="${escapeHtml(inputId)}">${escapeHtml(item.name)}</label>
        <code>${escapeHtml(item.id)}</code>
      </div>
    `;
    }).join("");

    const objectGroups = (options.objects || []).map((group) => {
      const tree = buildValueTree(group.values || []);
      const selected = group.selected;
      return `
        <details class="condition-group" open>
          <summary>
            <span class="condition-summary-title">
              <span>${escapeHtml(group.obj_name || group.obj_id)}</span>
              ${objectSelectionTags(group)}
            </span>
            <small>${(group.values || []).length}개</small>
          </summary>
          <div class="condition-group-body" data-condition-group-body="${escapeHtml(group.obj_id)}">
            <div class="condition-actions">
              <button class="text-button tiny" type="button" data-condition-action="select-all" data-obj-id="${escapeHtml(group.obj_id)}">전체</button>
              ${selected ? `<button class="text-button tiny" type="button" data-condition-action="select-descendants" data-obj-id="${escapeHtml(group.obj_id)}" data-value-id="${escapeHtml(selected.id)}">선택지역 하위 전체</button>` : ""}
              <div class="condition-row" style="--depth:0">
                <span class="condition-toggle-spacer"></span>
                <input id="condition-object-${escapeHtml(domIdPart(group.obj_id))}-ALL" class="condition-check" type="checkbox" data-kind="object" data-obj-id="${escapeHtml(group.obj_id)}" data-value-id="ALL" ${isChecked("object", group.obj_id, "ALL") ? "checked" : ""}>
                <label for="condition-object-${escapeHtml(domIdPart(group.obj_id))}-ALL">전체</label>
                <code>ALL</code>
              </div>
            </div>
            ${renderValueRows(tree, group.obj_id, tree.roots)}
          </div>
        </details>
      `;
    }).join("");

    treeNode.innerHTML = `
      <details class="condition-group" open>
        <summary>
          <span class="condition-summary-title">
            <span>항목</span>
            ${itemSelectionTags(items)}
          </span>
          <small>${items.length}개</small>
        </summary>
        <div class="condition-group-body" data-condition-group-body="items">
          ${itemRows || '<div class="empty">항목 정보 없음</div>'}
        </div>
      </details>
      ${objectGroups || '<div class="empty">분류 조건이 없습니다.</div>'}
    `;
    treeNode.scrollTop = treeScrollTop;
    revealConditionNode(treeNode, focus);
    updateConditionSummary();
  }

  function updateConditionSummary() {
    if (!currentDataOptions) return;
    const itemText = conditionState.itemIds.includes("ALL")
      ? "항목=전체"
      : `항목 ${conditionState.itemIds.length}개`;
    const objectText = (currentDataOptions.objects || [])
      .slice(0, 3)
      .map((group) => {
        const selected = conditionState.objects[group.obj_id] || ["ALL"];
        const label = selected.includes("ALL") ? "전체" : `${selected.length}개`;
        return `${group.obj_name || group.obj_id}=${label}`;
      })
      .join(" | ");
    $("#conditionSummary").textContent = [itemText, objectText].filter(Boolean).join(" | ");
  }

  async function loadDataOptions(table) {
    const token = ++optionLoadToken;
    currentDataOptions = null;
    conditionState = { itemIds: [], objects: {} };
    expandedConditionNodes = new Set();
    lastPreviewPayload = null;
    pivotConfig = { rows: [], cols: [], values: [], fields: [] };
    $("#previewDataButton").disabled = true;
    $("#dataOptionStatus").textContent = "조건 메타를 불러오는 중...";
    $("#conditionTree").innerHTML = '<div class="empty">조건 메타를 불러오는 중...</div>';
    $("#previewPane").innerHTML = '<div class="empty">통계표를 선택한 뒤 자료 미리보기를 실행하세요.</div>';
    if ($("#previewRowCount")) $("#previewRowCount").textContent = "";
    $("#previewStatus").textContent = "";

    try {
      const data = await request("/api/kosis/options", {
        method: "POST",
        body: JSON.stringify({
          orgId: table.orgId,
          tableId: table.tableId,
          regionName: currentRegionName()
        })
      });
      if (token !== optionLoadToken) return;
      currentDataOptions = data.options;
      conditionState = defaultConditionState(currentDataOptions);
      const regionText = data.options.regionMatch
        ? `지역 자동 선택: ${data.options.regionMatch.name}`
        : "지역 자동 선택 없음";
      $("#dataOptionStatus").textContent = regionText;
      renderConditionTree(currentDataOptions);
      // 기간 유형 표시
      const period = data.options.period;
      if (period) {
        const typeEl = $("#periodTypeInfo");
        if (typeEl) {
          const cycleName = { "Y": "연간", "M": "월간", "Q": "분기", "H": "반기", "D": "일별", "IR": "부정기" }[period.code] || period.label || "미확인";
          const range = (period.start && period.end) ? `${period.start} ~ ${period.end}` : "";
          typeEl.innerHTML = `<strong>${escapeHtml(cycleName)}</strong>${range ? ` <span class="period-range">(${escapeHtml(range)})</span>` : ""}`;
          typeEl.hidden = false;
        }
      }
      $("#previewDataButton").disabled = false;
      if (data.apiUsage) updateApiUsage(data.apiUsage);
    } catch (error) {
      if (token !== optionLoadToken) return;
      $("#dataOptionStatus").textContent = error.message;
      $("#conditionTree").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    }
  }

  function tableSearchText(table, folderName) {
    const yearCheck = table.yearCheck || {};
    return [
      folderName,
      table.title,
      table.agency,
      table.source,
      table.grade,
      table.score,
      table.regionSummary,
      table.detailSummary,
      table.latest,
      table.reason,
      yearCheck.label,
      yearCheck.rangeLabel,
      yearCheck.fetchRangeLabel,
      ...(table.regions || []),
      ...(table.matchTypes || [])
    ].join(" ").toLowerCase();
  }

  function filteredFolders(payload) {
    const keyword = ($("#resultSearch")?.value || "").trim().toLowerCase();
    const folders = payload?.folders || [];
    if (!keyword) {
      return folders.map((folder) => ({
        ...folder,
        tables: folder.tables || []
      }));
    }

    return folders
      .map((folder) => {
        const tables = (folder.tables || []).filter((table) => tableSearchText(table, folder.name).includes(keyword));
        return {
          ...folder,
          count: tables.length,
          tables
        };
      })
      .filter((folder) => folder.tables.length > 0);
  }

  function renderResults(payload) {
    currentPayload = payload;
    $("#resultSearch").value = "";
    $("#resultTitle").textContent = `${payload.sido} ${payload.sigungu || ""} ${payload.keyword}`.trim();
    renderFolderList();
  }

  function renderFolderList() {
    const payload = currentPayload;
    flatTables = [];
    selectedIndex = -1;
    const folders = filteredFolders(payload);
    const visibleTotal = folders.reduce((sum, folder) => sum + folder.tables.length, 0);
    const rawTotal = payload?.total || 0;
    const isFiltered = Boolean(($("#resultSearch")?.value || "").trim());
    $("#resultCount").textContent = isFiltered ? `${visibleTotal}/${rawTotal}건` : `${rawTotal}건`;

    if (!payload || !payload.folders || payload.folders.length === 0) {
      $("#folderList").innerHTML = '<div class="empty">검색 결과가 없습니다.</div>';
      renderDetail(null);
      return;
    }

    if (folders.length === 0) {
      $("#folderList").innerHTML = '<div class="empty">결과 내 검색에 맞는 통계표가 없습니다.</div>';
      renderDetail(null);
      return;
    }

    const html = folders.map((folder) => {
      const cards = folder.tables.map((table) => {
        const index = flatTables.push(table) - 1;
        return `
          <button class="table-row" type="button" data-table-index="${index}">
            <span class="table-title">${escapeHtml(table.title)}</span>
            <span class="table-meta">
              <span class="grade ${gradeClass(table.grade)}">${escapeHtml(table.grade)} ${escapeHtml(table.score)}</span>
              <span>${escapeHtml(table.agency)}</span>
              <span>${escapeHtml(table.source)}</span>
              ${renderYearBadges(table.yearCheck)}
              <span>${escapeHtml(table.regionSummary)}</span>
              <span>${escapeHtml(table.latest)}</span>
            </span>
          </button>
        `;
      }).join("");

      return `
        <section class="folder-block">
          <div class="folder-head">
            <h3>${escapeHtml(folder.name)}</h3>
            <span>${folder.count}건</span>
          </div>
          <div class="table-list">${cards}</div>
        </section>
      `;
    }).join("");

    $("#folderList").innerHTML = html;
    renderDetail(flatTables[0]);
    selectedIndex = 0;
    markSelected();
  }

  function markSelected() {
    document.querySelectorAll(".table-row").forEach((node) => {
      node.classList.toggle("active", Number(node.dataset.tableIndex) === selectedIndex);
    });
  }

  function tags(values) {
    if (!values || values.length === 0) return "";
    return values.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join("");
  }

  function renderCategories(table) {
    if (!table.categories || table.categories.length === 0) {
      return '<div class="empty">분류항목 정보가 없습니다.</div>';
    }

    return table.categories.map((group) => `
      <section class="category-group">
        <div class="category-head">
          <h4>${escapeHtml(group.name)}</h4>
          <span>${group.count}개</span>
        </div>
        <div class="category-values">
          ${group.values.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}
        </div>
      </section>
    `).join("");
  }

  function renderDetail(table) {
    if (!table) {
      currentTable = null;
      currentDataOptions = null;
      conditionState = { itemIds: [], objects: {} };
      expandedConditionNodes = new Set();
      $("#detailTitle").textContent = "통계표 선택";
      $("#detailPane").innerHTML = '<div class="empty">검색 결과에서 통계표를 선택하세요.</div>';
      return;
    }

    currentTable = table;
    $("#detailTitle").textContent = table.title;
    $("#detailPane").innerHTML = `
      <div class="detail-stack">
        <div class="detail-tabs" role="tablist" aria-label="통계표 상세">
          <button class="detail-tab-button active" type="button" role="tab" aria-selected="true" data-detail-tab="conditions">조건설정</button>
          <button class="detail-tab-button" type="button" role="tab" aria-selected="false" data-detail-tab="info">상세정보</button>
        </div>
        <div class="detail-tab-panel active" data-detail-panel="conditions" role="tabpanel">
          ${renderDataQueryShell(table)}
        </div>
        <div class="detail-tab-panel" data-detail-panel="info" role="tabpanel">
          <section>
            <div class="detail-kv">
              <span>기관</span><strong>${escapeHtml(table.agency)}</strong>
              <span>기관ID</span><strong>${escapeHtml(table.orgId)}</strong>
              <span>통계표ID</span><strong>${escapeHtml(table.tableId)}</strong>
              <span>수록기간</span><strong>${escapeHtml(table.period || table.latest)}</strong>
              <span>출처</span><strong>${escapeHtml(table.source)}</strong>
            </div>
          </section>
          <section class="tag-row">
            ${tags([table.agencyLevel, table.source, table.grade].filter(Boolean))}
            ${tags(table.regions)}
            ${tags(table.matchTypes)}
          </section>
          <section class="detail-summary">
            <p>${escapeHtml(table.reason || "기본 후보")}</p>
            <p>${escapeHtml(table.regionSummary)} | ${escapeHtml(table.detailSummary)}</p>
          </section>
          ${renderYearDetail(table.yearCheck)}
          <section>
            <h3 class="mini-heading">분류항목</h3>
            ${renderCategories(table)}
          </section>
        </div>
      </div>
    `;
    loadDataOptions(table);
  }

  function activateDetailTab(tabName) {
    $("#detailPane").querySelectorAll("[data-detail-tab]").forEach((button) => {
      const active = button.dataset.detailTab === tabName;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("#detailPane").querySelectorAll("[data-detail-panel]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.detailPanel === tabName);
    });
  }

  function handleConditionChange(event) {
    const input = event.target.closest(".condition-check");
    if (!input || !currentDataOptions) return;

    const kind = input.dataset.kind;
    const valueId = input.dataset.valueId;
    if (kind === "item") {
      if (input.checked) {
        if (!conditionState.itemIds.includes(valueId)) {
          conditionState.itemIds.push(valueId);
        }
      } else {
        conditionState.itemIds = conditionState.itemIds.filter((id) => id !== valueId);
      }
      if (conditionState.itemIds.length === 0) {
        conditionState.itemIds = [currentDataOptions.items?.[0]?.id || "ALL"];
      }
    } else {
      const objId = input.dataset.objId;
      const current = new Set(conditionState.objects[objId] || ["ALL"]);
      if (valueId === "ALL") {
        conditionState.objects[objId] = ["ALL"];
      } else {
        current.delete("ALL");
        if (input.checked) {
          current.add(valueId);
        } else {
          current.delete(valueId);
        }
        conditionState.objects[objId] = current.size ? Array.from(current) : ["ALL"];
      }
    }
    renderConditionTree(currentDataOptions);
  }

  function handleConditionAction(event) {
    const button = event.target.closest("[data-condition-action]");
    if (!button || !currentDataOptions) return;

    const objId = button.dataset.objId;
    const action = button.dataset.conditionAction;
    if (action === "toggle-node") {
      const key = conditionNodeKey(objId, button.dataset.valueId);
      const wasExpanded = expandedConditionNodes.has(key);
      if (wasExpanded) {
        expandedConditionNodes.delete(key);
      } else {
        expandedConditionNodes.add(key);
      }
      renderConditionTree(currentDataOptions, { nodeKey: key, revealChildren: !wasExpanded });
      return;
    }
    if (action === "select-all") {
      conditionState.objects[objId] = ["ALL"];
    }
    if (action === "select-descendants") {
      const group = (currentDataOptions.objects || []).find((item) => item.obj_id === objId);
      const ids = descendantIds(group?.values || [], button.dataset.valueId);
      conditionState.objects[objId] = ids.length ? ids : [button.dataset.valueId];
    }
    renderConditionTree(currentDataOptions);
  }

  function previewPeriodBody() {
    const startPeriod = $("#previewStartPeriod")?.value.trim() || "";
    const endPeriod = $("#previewEndPeriod")?.value.trim() || "";
    const latestCount = $("#previewLatestCount")?.value || "5";
    return { startPeriod, endPeriod, latestCount };
  }

  // ── 피벗 필드 정의 ──
  const FIELD_LABELS = {
    ITM_NM: "항목", C1_NM: "분류1", C2_NM: "분류2", C3_NM: "분류3",
    C4_NM: "분류4", C5_NM: "분류5", C6_NM: "분류6", C7_NM: "분류7", C8_NM: "분류8",
    PRD_DE: "기간", DT: "값", UNIT_NM: "단위"
  };
  const DIMENSION_CANDIDATES = ["ITM_NM", "C1_NM", "C2_NM", "C3_NM", "C4_NM", "C5_NM", "C6_NM", "C7_NM", "C8_NM", "PRD_DE"];
  const VALUE_CANDIDATES = ["DT"];

  function fieldLabel(col) { return FIELD_LABELS[col] || col; }

  function formatPeriod(p) {
    if (!p) return "";
    if (p.length === 6) return `${p.slice(0, 4)}.${p.slice(4)}`;
    return p;
  }

  // 데이터에서 사용 가능한 필드 추출 + 기본 배치
  function initPivotConfig(payload) {
    const dims = DIMENSION_CANDIDATES.filter((c) => payload.columns.includes(c) && payload.rows.some((r) => r[c]));
    const vals = VALUE_CANDIDATES.filter((c) => payload.columns.includes(c));
    const fields = [...dims, ...vals];

    // 기본 배치: 기간→열, 나머지 분류→행, DT→값
    const rows = dims.filter((c) => c !== "PRD_DE");
    const cols = dims.includes("PRD_DE") ? ["PRD_DE"] : [];
    pivotConfig = { rows, cols, values: vals.length ? vals : ["DT"], fields };
    return pivotConfig;
  }

  // 피벗 설정 UI 렌더
  function renderPivotConfigurator() {
    const el = document.getElementById("pivotConfigurator");
    if (!el) return;

    const allPlaced = [...pivotConfig.rows, ...pivotConfig.cols, ...pivotConfig.values];
    const unplaced = pivotConfig.fields.filter((f) => !allPlaced.includes(f));

    function chipHtml(field, zone) {
      const isPeriod = field === "PRD_DE";
      return `<span class="pivot-chip" draggable="true" data-pivot-field="${escapeHtml(field)}" data-pivot-zone="${zone}">${escapeHtml(fieldLabel(field))}${isPeriod ? "" : ""}</span>`;
    }

    function zoneHtml(id, label, fields, accepts) {
      const chips = fields.map((f) => chipHtml(f, id)).join("");
      return `
        <div class="pivot-zone" data-pivot-drop="${id}">
          <div class="pivot-zone-label">${escapeHtml(label)}</div>
          <div class="pivot-zone-chips">${chips || '<span class="pivot-zone-empty">여기로 드래그</span>'}</div>
        </div>
      `;
    }

    el.innerHTML = `
      <div class="pivot-config-grid">
        ${zoneHtml("unplaced", "필드 목록", unplaced)}
        ${zoneHtml("rows", "행", pivotConfig.rows)}
        ${zoneHtml("cols", "열", pivotConfig.cols)}
        ${zoneHtml("values", "값", pivotConfig.values)}
      </div>
      <div class="pivot-toolbar">
        <button class="text-button tiny" type="button" id="pivotSwapBtn">행열전환</button>
        <button class="text-button tiny" type="button" id="pivotResetBtn">초기화</button>
      </div>
    `;

    // 드래그앤드롭 바인딩
    bindPivotDragDrop(el);
  }

  // 드래그앤드롭 로직
  function bindPivotDragDrop(container) {
    let dragField = null;
    let dragSourceZone = null;

    container.addEventListener("dragstart", (e) => {
      const chip = e.target.closest(".pivot-chip");
      if (!chip) return;
      dragField = chip.dataset.pivotField;
      dragSourceZone = chip.dataset.pivotZone;
      chip.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragField);
    });

    container.addEventListener("dragend", (e) => {
      const chip = e.target.closest(".pivot-chip");
      if (chip) chip.classList.remove("dragging");
      container.querySelectorAll(".pivot-zone").forEach((z) => z.classList.remove("drag-over"));
      dragField = null;
      dragSourceZone = null;
    });

    container.addEventListener("dragover", (e) => {
      const zone = e.target.closest("[data-pivot-drop]");
      if (!zone) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      container.querySelectorAll(".pivot-zone").forEach((z) => z.classList.remove("drag-over"));
      zone.classList.add("drag-over");
    });

    container.addEventListener("dragleave", (e) => {
      const zone = e.target.closest("[data-pivot-drop]");
      if (zone && !zone.contains(e.relatedTarget)) {
        zone.classList.remove("drag-over");
      }
    });

    container.addEventListener("drop", (e) => {
      e.preventDefault();
      const zone = e.target.closest("[data-pivot-drop]");
      if (!zone || !dragField) return;
      zone.classList.remove("drag-over");

      const targetZone = zone.dataset.pivotDrop;
      if (dragSourceZone === targetZone) {
        // 같은 영역 안에서 순서 변경: 드롭 위치 기준으로 재배치
        reorderInZone(targetZone, dragField, e, zone);
      } else {
        movePivotField(dragField, dragSourceZone, targetZone);
      }

      renderPivotConfigurator();
      renderPivotFromConfig();
    });

    // 행열전환
    const swapBtn = container.querySelector("#pivotSwapBtn");
    if (swapBtn) {
      swapBtn.addEventListener("click", () => {
        const tmp = pivotConfig.rows;
        pivotConfig.rows = pivotConfig.cols;
        pivotConfig.cols = tmp;
        renderPivotConfigurator();
        renderPivotFromConfig();
      });
    }

    // 초기화
    const resetBtn = container.querySelector("#pivotResetBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        if (lastPreviewPayload) {
          initPivotConfig(lastPreviewPayload);
          renderPivotConfigurator();
          renderPivotFromConfig();
        }
      });
    }
  }

  function movePivotField(field, fromZone, toZone) {
    // 값 영역에는 DT만 허용
    if (toZone === "values" && field !== "DT") return;
    // DT는 행/열에 놓을 수 없음
    if ((toZone === "rows" || toZone === "cols") && field === "DT") return;

    // 소스에서 제거
    removeFromZone(field, fromZone);
    // 타겟에 추가
    addToZone(field, toZone);
  }

  function removeFromZone(field, zone) {
    if (zone === "rows") pivotConfig.rows = pivotConfig.rows.filter((f) => f !== field);
    else if (zone === "cols") pivotConfig.cols = pivotConfig.cols.filter((f) => f !== field);
    else if (zone === "values") pivotConfig.values = pivotConfig.values.filter((f) => f !== field);
    // unplaced는 별도 배열이 없으므로 무시
  }

  function addToZone(field, zone) {
    if (zone === "rows" && !pivotConfig.rows.includes(field)) pivotConfig.rows.push(field);
    else if (zone === "cols" && !pivotConfig.cols.includes(field)) pivotConfig.cols.push(field);
    else if (zone === "values" && !pivotConfig.values.includes(field)) pivotConfig.values.push(field);
    // unplaced = 아무 zone에도 안 넣으면 자동으로 unplaced
  }

  function reorderInZone(zone, field, event, zoneEl) {
    let arr;
    if (zone === "rows") arr = pivotConfig.rows;
    else if (zone === "cols") arr = pivotConfig.cols;
    else return;

    const idx = arr.indexOf(field);
    if (idx === -1) return;

    // 드롭 위치 결정: 각 칩의 위치와 비교
    const chips = zoneEl.querySelectorAll(".pivot-chip");
    let insertIdx = arr.length;
    for (let i = 0; i < chips.length; i++) {
      const rect = chips[i].getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        insertIdx = i;
        break;
      }
    }

    arr.splice(idx, 1);
    if (insertIdx > idx) insertIdx--;
    arr.splice(insertIdx, 0, field);
  }

  // 피벗 테이블 렌더링 (설정 기반)
  function renderPivotFromConfig() {
    const pane = document.getElementById("pivotTableArea");
    if (!pane || !lastPreviewPayload) return;
    const data = lastPreviewPayload.rows;
    if (!data || data.length === 0) {
      pane.innerHTML = '<div class="empty">데이터가 없습니다.</div>';
      return;
    }

    const rowFields = pivotConfig.rows;
    const colFields = pivotConfig.cols;
    const valField = pivotConfig.values[0] || "DT";

    if (rowFields.length === 0 && colFields.length === 0) {
      pane.innerHTML = '<div class="empty">행 또는 열에 필드를 배치하세요.</div>';
      return;
    }

    // 단위
    const unit = data.find((r) => r.UNIT_NM)?.UNIT_NM || "";

    // 열 헤더 고유값 (다중 열이면 조합)
    const colKeys = [];
    const colKeySet = new Set();
    for (const row of data) {
      const key = colFields.map((c) => row[c] ?? "").join("|||");
      if (!colKeySet.has(key)) {
        colKeySet.add(key);
        colKeys.push({ key, labels: colFields.map((c) => row[c] ?? "") });
      }
    }
    colKeys.sort((a, b) => a.key.localeCompare(b.key));

    // 행 그룹핑
    const rowMap = new Map();
    const rowOrder = [];
    for (const row of data) {
      const rk = rowFields.map((c) => row[c] ?? "").join("|||");
      const ck = colFields.map((c) => row[c] ?? "").join("|||");
      if (!rowMap.has(rk)) {
        rowMap.set(rk, { labels: rowFields.map((c) => row[c] ?? ""), values: {} });
        rowOrder.push(rk);
      }
      rowMap.get(rk).values[ck] = row[valField] ?? "";
    }

    // 열 헤더
    const colHeaderLabel = (ck) => {
      return ck.labels.map((v, i) => {
        return colFields[i] === "PRD_DE" ? formatPeriod(v) : v;
      }).join(" / ");
    };

    const thRow = rowFields.map((c) => `<th class="classify-col">${escapeHtml(fieldLabel(c))}</th>`).join("");
    const thCol = colKeys.map((ck) => `<th class="period-col">${escapeHtml(colHeaderLabel(ck))}</th>`).join("");

    // 열이 없으면 값 컬럼 하나만
    const hasColFields = colFields.length > 0;

    let tbody = "";
    // 행 병합 처리: 상위 필드가 같으면 rowspan
    const prevVals = new Array(rowFields.length).fill(null);
    const rowEntries = rowOrder.map((rk) => rowMap.get(rk));

    for (let ri = 0; ri < rowEntries.length; ri++) {
      const entry = rowEntries[ri];
      let rowHtml = "";

      for (let fi = 0; fi < rowFields.length; fi++) {
        const val = entry.labels[fi];
        // rowspan 계산: 현재 셀부터 아래로 같은 값이 연속되는 수
        let isSameAsPrev = true;
        for (let k = 0; k <= fi; k++) {
          if (entry.labels[k] !== prevVals[k]) { isSameAsPrev = false; break; }
        }
        if (isSameAsPrev && ri > 0) continue; // 이전 행에서 rowspan으로 처리됨

        let span = 1;
        for (let j = ri + 1; j < rowEntries.length; j++) {
          let allMatch = true;
          for (let k = 0; k <= fi; k++) {
            if (rowEntries[j].labels[k] !== entry.labels[k]) { allMatch = false; break; }
          }
          if (allMatch) span++;
          else break;
        }

        rowHtml += `<td class="classify-cell"${span > 1 ? ` rowspan="${span}"` : ""}>${escapeHtml(val)}</td>`;
      }

      if (hasColFields) {
        for (const ck of colKeys) {
          const v = entry.values[ck.key];
          const formatted = v !== "" && v !== undefined && !isNaN(Number(v))
            ? Number(v).toLocaleString() : escapeHtml(v ?? "-");
          rowHtml += `<td class="num-cell">${formatted}</td>`;
        }
      } else {
        const v = entry.values[""];
        const formatted = v !== "" && v !== undefined && !isNaN(Number(v))
          ? Number(v).toLocaleString() : escapeHtml(v ?? "-");
        rowHtml += `<td class="num-cell">${formatted}</td>`;
      }

      tbody += `<tr>${rowHtml}</tr>`;

      // prevVals 갱신
      for (let fi = 0; fi < rowFields.length; fi++) {
        prevVals[fi] = entry.labels[fi];
      }
    }

    const meta = [unit ? `단위: ${unit}` : "", `${lastPreviewPayload.displayedRows}/${lastPreviewPayload.rowCount}행`].filter(Boolean).join("  |  ");

    pane.innerHTML = `
      <div class="preview-table-meta">${escapeHtml(meta)}</div>
      <div class="preview-table-scroll pivot">
        <table class="preview-table pivot-table">
          <thead><tr>${thRow}${hasColFields ? thCol : '<th class="period-col">값</th>'}</tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
    `;
  }

  function renderPreviewTable(payload) {
    const pane = $("#previewPane");
    const countEl = $("#previewRowCount");
    if (!payload.rows || payload.rows.length === 0) {
      pane.innerHTML = '<div class="empty">조회된 데이터가 없습니다.</div>';
      if (countEl) countEl.textContent = "";
      return;
    }
    if (countEl) countEl.textContent = `${payload.displayedRows}/${payload.rowCount}행`;

    lastPreviewPayload = payload;
    initPivotConfig(payload);

    pane.innerHTML = `
      <div id="pivotConfigurator"></div>
      <div id="pivotTableArea"></div>
    `;

    renderPivotConfigurator();
    renderPivotFromConfig();

    // 버튼 활성화
    const dlBtn = $("#downloadXlsxBtn");
    const chartBtn = $("#toggleChartBtn");
    if (dlBtn) dlBtn.disabled = false;
    if (chartBtn) chartBtn.disabled = false;
  }

  // ── 엑셀 다운로드 ──
  function downloadPivotXlsx(includeChartImage) {
    if (!lastPreviewPayload || !lastPreviewPayload.rows.length) return;
    const data = lastPreviewPayload.rows;
    const rowFields = pivotConfig.rows;
    const colFields = pivotConfig.cols;
    const valField = pivotConfig.values[0] || "DT";

    // 열 키
    const colKeys = [];
    const colKeySet = new Set();
    for (const row of data) {
      const key = colFields.map((c) => row[c] ?? "").join("|||");
      if (!colKeySet.has(key)) {
        colKeySet.add(key);
        colKeys.push({ key, labels: colFields.map((c) => row[c] ?? "") });
      }
    }
    colKeys.sort((a, b) => a.key.localeCompare(b.key));

    // 행 그룹핑
    const rowMap = new Map();
    const rowOrder = [];
    for (const row of data) {
      const rk = rowFields.map((c) => row[c] ?? "").join("|||");
      const ck = colFields.map((c) => row[c] ?? "").join("|||");
      if (!rowMap.has(rk)) {
        rowMap.set(rk, { labels: rowFields.map((c) => row[c] ?? ""), values: {} });
        rowOrder.push(rk);
      }
      rowMap.get(rk).values[ck] = row[valField] ?? "";
    }

    const colHeaderLabel = (ck) => ck.labels.map((v, i) =>
      colFields[i] === "PRD_DE" ? formatPeriod(v) : v
    ).join(" / ");

    // 시트 데이터 구성
    const header = [
      ...rowFields.map((c) => fieldLabel(c)),
      ...(colKeys.length ? colKeys.map(colHeaderLabel) : ["값"])
    ];

    const sheetData = [header];
    for (const rk of rowOrder) {
      const entry = rowMap.get(rk);
      const rowArr = [...entry.labels];
      if (colKeys.length) {
        for (const ck of colKeys) {
          const v = entry.values[ck.key];
          rowArr.push(v !== "" && v !== undefined && !isNaN(Number(v)) ? Number(v) : v ?? "");
        }
      } else {
        const v = entry.values[""];
        rowArr.push(v !== "" && v !== undefined && !isNaN(Number(v)) ? Number(v) : v ?? "");
      }
      sheetData.push(rowArr);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(sheetData);

    // 열 너비 자동 조정
    const colWidths = header.map((h, i) => {
      let max = String(h).length;
      for (const row of sheetData) {
        max = Math.max(max, String(row[i] ?? "").length);
      }
      return { wch: Math.min(max + 2, 30) };
    });
    ws["!cols"] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, "데이터");

    // 차트 이미지 삽입 (비동기)
    if (includeChartImage && typeof Plotly !== "undefined" && $("#chartArea")?.data?.length) {
      Plotly.toImage($("#chartArea"), { format: "png", width: 900, height: 500 }).then((dataUrl) => {
        // 이미지 시트 추가는 SheetJS 무료 버전에서 직접 지원하지 않으므로,
        // 별도 시트에 URL 참조를 남기거나, 데이터만 저장
        XLSX.writeFile(wb, generateXlsxFilename());
      });
    } else {
      XLSX.writeFile(wb, generateXlsxFilename());
    }
  }

  function generateXlsxFilename() {
    const title = currentTable?.title || "kosis_data";
    const safe = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    return `${safe}_${date}.xlsx`;
  }

  // ── 그래프 (Plotly.js) ──
  let chartVisible = false;

  function toggleChart() {
    const panel = $("#chartPanel");
    if (!panel) return;
    chartVisible = !chartVisible;
    panel.hidden = !chartVisible;
    if (chartVisible && lastPreviewPayload) {
      renderChart();
    }
  }

  function renderChart() {
    const chartArea = document.getElementById("chartArea");
    if (!chartArea || !lastPreviewPayload) return;

    const data = lastPreviewPayload.rows;
    const rowFields = pivotConfig.rows;
    const colFields = pivotConfig.cols;
    const valField = pivotConfig.values[0] || "DT";
    const chartType = $("#chartTypeSelect")?.value || "bar";

    // 열 키
    const colKeys = [];
    const colKeySet = new Set();
    for (const row of data) {
      const key = colFields.map((c) => row[c] ?? "").join("|||");
      if (!colKeySet.has(key)) {
        colKeySet.add(key);
        colKeys.push({ key, labels: colFields.map((c) => row[c] ?? "") });
      }
    }
    colKeys.sort((a, b) => a.key.localeCompare(b.key));

    // 행 그룹핑
    const rowMap = new Map();
    const rowOrder = [];
    for (const row of data) {
      const rk = rowFields.map((c) => row[c] ?? "").join("|||");
      const ck = colFields.map((c) => row[c] ?? "").join("|||");
      if (!rowMap.has(rk)) {
        rowMap.set(rk, { labels: rowFields.map((c) => row[c] ?? ""), values: {} });
        rowOrder.push(rk);
      }
      rowMap.get(rk).values[ck] = row[valField] ?? "";
    }

    const colHeaderLabel = (ck) => ck.labels.map((v, i) =>
      colFields[i] === "PRD_DE" ? formatPeriod(v) : v
    ).join(" / ");

    const xLabels = rowOrder.map((rk) => {
      const entry = rowMap.get(rk);
      return entry.labels.join(" / ");
    });

    if (chartType === "pie") {
      // 원형: 첫 번째 열 키의 값만 사용
      const ck = colKeys[0];
      const vals = rowOrder.map((rk) => {
        const v = rowMap.get(rk).values[ck?.key || ""];
        return v !== "" && !isNaN(Number(v)) ? Number(v) : 0;
      });
      const traces = [{ labels: xLabels, values: vals, type: "pie" }];
      Plotly.newPlot(chartArea, traces, {
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#ccc", size: 11 },
        margin: { t: 30, b: 30, l: 30, r: 30 }
      }, { responsive: true });
    } else {
      // 막대/선형/산점도: 각 열 키가 하나의 시리즈
      const traces = (colKeys.length ? colKeys : [{ key: "", labels: ["값"] }]).map((ck) => {
        const yVals = rowOrder.map((rk) => {
          const v = rowMap.get(rk).values[ck.key];
          return v !== "" && v !== undefined && !isNaN(Number(v)) ? Number(v) : null;
        });
        return {
          x: xLabels,
          y: yVals,
          name: colHeaderLabel(ck),
          type: chartType === "scatter" ? "scatter" : chartType === "line" ? "scatter" : "bar",
          mode: chartType === "line" ? "lines+markers" : chartType === "scatter" ? "markers" : undefined
        };
      });

      Plotly.newPlot(chartArea, traces, {
        barmode: "group",
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        font: { color: "#ccc", size: 11 },
        xaxis: { gridcolor: "#333", tickangle: -45 },
        yaxis: { gridcolor: "#333" },
        legend: { orientation: "h", y: -0.25 },
        margin: { t: 20, b: 100, l: 60, r: 20 }
      }, { responsive: true });
    }
  }

  async function previewSelectedData() {
    if (!currentTable || !currentDataOptions) return;
    const button = $("#previewDataButton");
    const period = previewPeriodBody();
    button.disabled = true;
    $("#previewStatus").textContent = "자료 조회 중...";
    $("#previewPane").innerHTML = '<div class="empty">자료 조회 중...</div>';
    const countEl = $("#previewRowCount");
    if (countEl) countEl.textContent = "";

    try {
      const payload = await request("/api/kosis/preview", {
        method: "POST",
        body: JSON.stringify({
          orgId: currentTable.orgId,
          tableId: currentTable.tableId,
          regionName: currentRegionName(),
          itemIds: conditionState.itemIds,
          objectSelections: conditionState.objects,
          latestCount: period.latestCount,
          startPeriod: period.startPeriod,
          endPeriod: period.endPeriod
        })
      });
      $("#previewStatus").textContent = `조회 완료: ${payload.rowCount}행`;
      renderPreviewTable(payload);
      if (payload.apiUsage) updateApiUsage(payload.apiUsage);
    } catch (error) {
      $("#previewStatus").textContent = error.message;
      $("#previewPane").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    } finally {
      button.disabled = false;
    }
  }

  function selectedWindowYears(body) {
    if (body.yearWindow === "custom") {
      return body.customYearWindow || "5";
    }
    return body.yearWindow || "5";
  }

  function yearCriteriaText(body) {
    if (!body.reportYear) {
      return "기준년도 판정 없음";
    }
    const windowYears = selectedWindowYears(body);
    const latest = body.includeLatestData ? "최신자료 포함 예정" : "기준기간만";
    return `기준년도 ${body.reportYear} · ${windowYears}년 이내 · ${latest}`;
  }

  function updateCustomYearWindowState() {
    const customSelected = document.querySelector('input[name="yearWindow"]:checked')?.value === "custom";
    $("#customYearWindowInput").disabled = !customSelected;
  }

  function buildSearchBody() {
    const selectedYearWindow = document.querySelector('input[name="yearWindow"]:checked')?.value || "5";
    return {
      sido: $("#sidoSelect").value,
      sigungu: $("#sigunguSelect").value,
      keyword: $("#keywordInput").value.trim(),
      includeSubregionSearch: $("#subregionSearch").checked,
      reportYear: $("#reportYearInput").value.trim(),
      yearWindow: selectedYearWindow,
      customYearWindow: $("#customYearWindowInput").value.trim(),
      includeLatestData: $("#includeLatestData").checked
    };
  }

  async function search(event, options = {}) {
    event?.preventDefault();
    const forceRefresh = Boolean(options.forceRefresh);
    const button = $("#searchButton");
    const freshButton = $("#freshSearchButton");
    const body = buildSearchBody();

    if (!body.keyword) return;

    if (!forceRefresh) {
      const cached = readCachedSearch(body);
      if (cached?.payload) {
        renderResults(cached.payload);
        updateSearchProgress(100, `저장된 검색 결과 불러옴: ${cached.payload.total || 0}건`);
        updateApiUsage(cached.payload.apiUsage || {});
        setStatus(`저장된 결과: ${cached.payload.total || 0}건`, "ok");
        setSearchLog([
          `${cachedAtText(cached.savedAt)} 저장된 결과`,
          `${body.sido} ${body.sigungu} / ${body.keyword}`,
          "필요하면 아래 '다시 새롭게 검색'으로 KOSIS API를 다시 호출하세요."
        ]);
        return;
      }
    }

    button.disabled = true;
    freshButton.disabled = true;
    const startedAt = new Date();
    setStatus(forceRefresh ? "새롭게 검색 중..." : "검색 중...", "");
    updateApiUsage({ recent_calls: 0, session_calls: 0, total_calls: 0, rate_limit_per_minute: 1000, usage_percent: 0 });
    updateSearchProgress(2, "검색 작업 준비 중...");
    currentPayload = null;
    $("#resultSearch").value = "";
    $("#resultCount").textContent = "0건";
    setSearchLog([
      `${formatClock(startedAt)} 검색 시작`,
      `${body.sido} ${body.sigungu} / ${body.keyword}`,
      yearCriteriaText(body),
      "통합검색과 지역지표 후보를 확인하는 중..."
    ]);
    $("#folderList").innerHTML = '<div class="empty">검색 중...</div>';

    try {
      let payload;
      try {
        const job = await request("/api/kosis/search/start", {
          method: "POST",
          body: JSON.stringify(body)
        });
        updateSearchProgress(job.progress, job.message);
        payload = await pollSearchJob(job.jobId, startedAt, body);
      } catch (error) {
        if (!supportsLegacySearch(error)) {
          throw error;
        }
        payload = await runLegacySearch(body);
      }
      renderResults(payload);
      const cached = writeCachedSearch(body, payload);
      const usage = payload.apiUsage || {};
      updateApiUsage(usage);
      updateSearchProgress(100, `검색 완료: ${payload.total || 0}건`);
      const finishedAt = new Date();
      const seconds = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
      setStatus(`검색 완료: ${payload.total || 0}건`, "ok");
      setSearchLog([
        `${formatClock(finishedAt)} 검색 완료 (${seconds}초)`,
        `결과 ${payload.total || 0}건 · 폴더 ${(payload.folders || []).length}개`,
        `API 이번 검색 ${usage.session_calls || 0}회 · 최근 60초 ${usage.recent_calls || 0}/${usage.rate_limit_per_minute || 1000}회`,
        cached ? "검색 결과 저장 완료" : "검색 결과 저장 실패"
      ]);
    } catch (error) {
      $("#folderList").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
      renderDetail(null);
      setStatus(error.message, "warn");
      if (String(error.message || "").includes("로컬 서버")) {
        setServerHelpVisible(true);
      }
      updateSearchProgress(100, "검색 실패");
      setSearchLog([
        `${formatClock(new Date())} 검색 실패`,
        error.message
      ]);
    } finally {
      button.disabled = false;
      freshButton.disabled = false;
    }
  }

  // ── 패널 접기/펼치기 ──
  const PANEL_NAMES = { search: "검색", results: "결과", detail: "상세" };
  const collapsedPanels = new Set();

  function togglePanel(panelId) {
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (!panel) return;

    if (collapsedPanels.has(panelId)) {
      // 펼치기
      collapsedPanels.delete(panelId);
      panel.classList.remove("collapsed");
      const bar = panel.querySelector(".panel-collapsed-bar");
      if (bar) bar.remove();
    } else {
      // 접기
      collapsedPanels.add(panelId);
      panel.classList.add("collapsed");
      const bar = document.createElement("div");
      bar.className = "panel-collapsed-bar";
      bar.innerHTML = `
        <button class="panel-toggle-btn" type="button" title="펼치기">&rsaquo;</button>
        <span class="panel-collapsed-label">${escapeHtml(PANEL_NAMES[panelId] || panelId)}</span>
      `;
      bar.addEventListener("click", () => togglePanel(panelId));
      panel.appendChild(bar);
    }
    updateLayoutGrid();
  }

  function updateLayoutGrid() {
    const layout = document.querySelector(".kosis-layout");
    if (!layout) return;
    const cols = [
      collapsedPanels.has("search") ? "32px" : "280px",
      collapsedPanels.has("results") ? "32px" : "minmax(320px, 1fr)",
      collapsedPanels.has("detail") ? "32px" : "minmax(320px, 1fr)",
      "minmax(400px, 1.6fr)"
    ];
    layout.style.gridTemplateColumns = cols.join(" ");
  }

  function bindEvents() {
    $("#sidoSelect").addEventListener("change", renderSigunguOptions);
    $("#kosisSearchForm").addEventListener("submit", search);
    $("#freshSearchButton").addEventListener("click", () => search(null, { forceRefresh: true }));
    document.querySelectorAll('input[name="yearWindow"]').forEach((input) => {
      input.addEventListener("change", updateCustomYearWindowState);
    });
    $("#resultSearch").addEventListener("input", () => {
      if (currentPayload) {
        renderFolderList();
      }
    });
    $("#copyLauncherPath").addEventListener("click", async () => {
      try {
        await copyText(launcherPath);
        $("#launcherCopyStatus").textContent = "경로를 복사했습니다. 파일 탐색기 주소창에 붙여넣고 실행하세요.";
      } catch (error) {
        $("#launcherCopyStatus").textContent = launcherPath;
      }
    });
    $("#detailPane").addEventListener("change", handleConditionChange);
    $("#detailPane").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-detail-tab]");
      if (tab) {
        activateDetailTab(tab.dataset.detailTab);
        return;
      }
      if (event.target.closest("#previewDataButton")) {
        previewSelectedData();
        return;
      }
      handleConditionAction(event);
    });
    $("#folderList").addEventListener("click", (event) => {
      const row = event.target.closest(".table-row");
      if (!row) return;
      selectedIndex = Number(row.dataset.tableIndex);
      renderDetail(flatTables[selectedIndex]);
      markSelected();
    });

    // 패널 접기 버튼
    document.querySelectorAll("[data-toggle-panel]").forEach((btn) => {
      btn.addEventListener("click", () => togglePanel(btn.dataset.togglePanel));
    });

    // 엑셀 다운로드
    $("#downloadXlsxBtn").addEventListener("click", () => downloadPivotXlsx(chartVisible));

    // 그래프 토글
    $("#toggleChartBtn").addEventListener("click", toggleChart);

    // 차트 종류 변경
    $("#chartTypeSelect").addEventListener("change", () => {
      if (chartVisible && lastPreviewPayload) renderChart();
    });
  }

  async function init() {
    bindEvents();
    updateCustomYearWindowState();
    await loadRegions();
  }

  init();
})();

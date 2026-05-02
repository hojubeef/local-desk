(function () {
  const storageKeys = {
    data: "localDesk.portalData.v1",
    legacyPosts: "localDesk.posts",
    legacyApps: "localDesk.customApps"
  };
  const apiBase = location.protocol === "http:" ? "" : "http://127.0.0.1:8765";

  const visibilityLabels = {
    active: "활성",
    archived: "보관",
    hidden: "숨김"
  };
  const todoStatusLabels = {
    todo: "예정",
    doing: "진행중",
    done: "완료",
    hold: "보류"
  };
  const priorityLabels = {
    high: "높음",
    normal: "보통",
    low: "낮음"
  };

  const defaultCategories = {
    posts: [
      { id: "post-memo", name: "메모", parentId: "" },
      { id: "post-work", name: "작업", parentId: "" },
      { id: "post-kosis", name: "KOSIS", parentId: "" },
      { id: "post-idea", name: "아이디어", parentId: "" }
    ],
    apps: [
      { id: "app-stats", name: "통계", parentId: "" },
      { id: "app-tools", name: "도구", parentId: "" },
      { id: "app-docs", name: "문서", parentId: "" },
      { id: "app-later", name: "나중에 정리", parentId: "" }
    ],
    todos: [
      { id: "todo-work", name: "업무", parentId: "" },
      { id: "todo-report", name: "보고서", parentId: "" },
      { id: "todo-personal", name: "개인", parentId: "" },
      { id: "todo-later", name: "나중에", parentId: "" }
    ],
    links: [
      { id: "link-work", name: "업무", parentId: "" },
      { id: "link-data", name: "자료", parentId: "" },
      { id: "link-reference", name: "참고", parentId: "" },
      { id: "link-favorite", name: "자주 씀", parentId: "" }
    ],
    events: [
      { id: "event-work", name: "업무", parentId: "" },
      { id: "event-deadline", name: "마감", parentId: "" },
      { id: "event-personal", name: "개인", parentId: "" }
    ]
  };

  const defaultAppMeta = {
    kosis: { categoryId: "app-stats", tags: ["KOSIS", "통계"], status: "active", favorite: true },
    "kosis-gui": { categoryId: "app-stats", tags: ["KOSIS", "GUI"], status: "archived", favorite: false },
    "kosis-debug": { categoryId: "app-tools", tags: ["KOSIS", "점검"], status: "archived", favorite: false },
    readme: { categoryId: "app-docs", tags: ["문서", "설명"], status: "active", favorite: false }
  };

  const baseApps = Array.isArray(window.portalApps) ? window.portalApps : [];
  const baseAppIds = new Set(baseApps.map((app) => app.id));

  const state = {
    data: loadLocalPortalData(),
    section: "home",
    calendarMonth: new Date(),
    serverBacked: false,
    saveTimer: null,
    googleCalendar: {
      configured: false,
      connected: false,
      syncing: false,
      message: "연결 확인 전",
      needsReconnect: false,
      calendars: [],
      syncedMonths: new Set()
    },
    git: {
      snapshot: null,
      busy: false,
      output: "아직 실행한 작업이 없습니다."
    },
    filters: {
      posts: { categoryId: "all", tag: "", status: "active", keyword: "" },
      apps: { categoryId: "all", tag: "", status: "active", keyword: "" },
      todos: { categoryId: "all", tag: "", status: "open", keyword: "" },
      links: { categoryId: "all", tag: "", status: "active", keyword: "" }
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function makeId(prefix) {
    if (crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function todayIso() {
    const now = new Date();
    return dateIso(now);
  }

  function dateIso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function normalizeVisibility(value) {
    return visibilityLabels[value] ? value : "active";
  }

  function normalizeTodoStatus(value) {
    return todoStatusLabels[value] ? value : "todo";
  }

  function normalizePriority(value) {
    return priorityLabels[value] ? value : "normal";
  }

  function normalizeTags(value) {
    const raw = Array.isArray(value) ? value : String(value || "").split(/[,\n]/);
    const seen = new Set();
    return raw
      .map((tag) => String(tag || "").trim().replace(/^#/, ""))
      .filter(Boolean)
      .filter((tag) => {
        const key = tag.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function tagInput(tags) {
    return normalizeTags(tags).join(", ");
  }

  function ensureCategories(saved, type) {
    const fallback = defaultCategories[type] || [];
    const merged = [...fallback, ...(Array.isArray(saved) ? saved : [])];
    const seen = new Set();
    return merged
      .map((category) => ({
        id: String(category.id || makeId(`${type}-cat`)),
        name: String(category.name || "").trim(),
        parentId: String(category.parentId || "")
      }))
      .filter((category) => category.name)
      .filter((category) => {
        if (seen.has(category.id)) return false;
        seen.add(category.id);
        return true;
      });
  }

  function categoryByName(categories, type, name, fallbackId) {
    const list = categories[type] || [];
    const found = list.find((category) => category.name === name);
    return found?.id || fallbackId || list[0]?.id || "";
  }

  function defaultPortalData() {
    return {
      version: 2,
      categories: {
        posts: ensureCategories([], "posts"),
        apps: ensureCategories([], "apps"),
        todos: ensureCategories([], "todos"),
        links: ensureCategories([], "links"),
        events: ensureCategories([], "events")
      },
      posts: [],
      customApps: [],
      appMeta: { ...defaultAppMeta },
      todos: [],
      links: [],
      events: [],
      calendarSettings: {
        provider: "local",
        google: { status: "not-configured", calendarId: "__all__", lastSyncAt: "" }
      }
    };
  }

  function normalizePost(post, categories) {
    const createdAt = Number(post.createdAt || Date.now());
    return {
      id: String(post.id || makeId("post")),
      title: String(post.title || "").trim(),
      body: String(post.body || "").trim(),
      categoryId: post.categoryId || categoryByName(categories, "posts", post.category, "post-memo"),
      tags: normalizeTags(post.tags),
      status: normalizeVisibility(post.status),
      createdAt,
      updatedAt: Number(post.updatedAt || createdAt)
    };
  }

  function normalizeCustomApp(app, categories) {
    const createdAt = Number(app.createdAt || Date.now());
    return {
      id: String(app.id || makeId("custom")),
      name: String(app.name || "").trim(),
      type: String(app.type || "page"),
      path: String(app.path || "").trim(),
      description: String(app.description || "").trim(),
      initials: String(app.initials || app.name?.slice(0, 2) || "AP").toUpperCase(),
      categoryId: app.categoryId || categoryByName(categories, "apps", app.category, "app-tools"),
      tags: normalizeTags(app.tags),
      status: normalizeVisibility(app.status),
      favorite: Boolean(app.favorite),
      createdAt,
      updatedAt: Number(app.updatedAt || createdAt)
    };
  }

  function normalizeMeta(meta, appId) {
    const base = defaultAppMeta[appId] || {};
    return {
      categoryId: String(meta?.categoryId || base.categoryId || "app-tools"),
      tags: normalizeTags(meta?.tags || base.tags || []),
      status: normalizeVisibility(meta?.status || base.status),
      favorite: Boolean(meta?.favorite ?? base.favorite),
      overrides: {
        name: String(meta?.overrides?.name || ""),
        type: String(meta?.overrides?.type || ""),
        path: String(meta?.overrides?.path || ""),
        description: String(meta?.overrides?.description || ""),
        initials: String(meta?.overrides?.initials || "")
      }
    };
  }

  function normalizeTodo(todo, categories) {
    const createdAt = Number(todo.createdAt || Date.now());
    return {
      id: String(todo.id || makeId("todo")),
      parentId: String(todo.parentId || ""),
      title: String(todo.title || "").trim(),
      notes: String(todo.notes || todo.body || "").trim(),
      categoryId: todo.categoryId || categoryByName(categories, "todos", todo.category, "todo-work"),
      tags: normalizeTags(todo.tags),
      status: normalizeTodoStatus(todo.status),
      priority: normalizePriority(todo.priority),
      dueDate: String(todo.dueDate || ""),
      order: Number(todo.order || createdAt),
      createdAt,
      updatedAt: Number(todo.updatedAt || createdAt)
    };
  }

  function normalizeLink(link, categories) {
    const createdAt = Number(link.createdAt || Date.now());
    return {
      id: String(link.id || makeId("link")),
      name: String(link.name || link.title || "").trim(),
      url: String(link.url || link.path || "").trim(),
      description: String(link.description || "").trim(),
      categoryId: link.categoryId || categoryByName(categories, "links", link.category, "link-work"),
      tags: normalizeTags(link.tags),
      status: normalizeVisibility(link.status),
      favorite: Boolean(link.favorite),
      createdAt,
      updatedAt: Number(link.updatedAt || createdAt)
    };
  }

  function normalizeEvent(event, categories) {
    const createdAt = Number(event.createdAt || Date.now());
    return {
      id: String(event.id || makeId("event")),
      title: String(event.title || "").trim(),
      date: String(event.date || todayIso()),
      startTime: String(event.startTime || ""),
      endTime: String(event.endTime || ""),
      notes: String(event.notes || "").trim(),
      categoryId: event.categoryId || categoryByName(categories, "events", event.category, "event-work"),
      tags: normalizeTags(event.tags),
      source: String(event.source || "local"),
      externalId: String(event.externalId || ""),
      externalCalendarId: String(event.externalCalendarId || "primary"),
      externalCalendarName: String(event.externalCalendarName || ""),
      syncStatus: String(event.syncStatus || "local-only"),
      createdAt,
      updatedAt: Number(event.updatedAt || createdAt)
    };
  }

  function normalizePortalData(raw) {
    const categories = {
      posts: ensureCategories(raw?.categories?.posts, "posts"),
      apps: ensureCategories(raw?.categories?.apps, "apps"),
      todos: ensureCategories(raw?.categories?.todos, "todos"),
      links: ensureCategories(raw?.categories?.links, "links"),
      events: ensureCategories(raw?.categories?.events, "events")
    };
    const appMeta = {};
    const sourceMeta = { ...defaultAppMeta, ...(raw?.appMeta || {}) };
    for (const appId of Object.keys(sourceMeta)) {
      appMeta[appId] = normalizeMeta(sourceMeta[appId], appId);
    }
    return {
      version: 2,
      categories,
      posts: (Array.isArray(raw?.posts) ? raw.posts : []).map((post) => normalizePost(post, categories)).filter((post) => post.title && post.body),
      customApps: (Array.isArray(raw?.customApps) ? raw.customApps : []).map((app) => normalizeCustomApp(app, categories)).filter((app) => app.name && app.path),
      appMeta,
      todos: (Array.isArray(raw?.todos) ? raw.todos : []).map((todo) => normalizeTodo(todo, categories)).filter((todo) => todo.title),
      links: (Array.isArray(raw?.links) ? raw.links : []).map((link) => normalizeLink(link, categories)).filter((link) => link.name && link.url),
      events: (Array.isArray(raw?.events) ? raw.events : []).map((event) => normalizeEvent(event, categories)).filter((event) => event.title && event.date),
      calendarSettings: {
        provider: raw?.calendarSettings?.provider || "local",
        google: {
          status: raw?.calendarSettings?.google?.status || "not-configured",
          calendarId: raw?.calendarSettings?.google?.calendarId || "__all__",
          lastSyncAt: raw?.calendarSettings?.google?.lastSyncAt || ""
        }
      }
    };
  }

  function isGoogleEvent(event) {
    return event?.source === "google" || Boolean(event?.externalId);
  }

  function cloneData(data) {
    return JSON.parse(JSON.stringify(data));
  }

  function portalDataForGit(data) {
    const snapshot = cloneData(normalizePortalData(data));
    snapshot.events = snapshot.events.filter((event) => !isGoogleEvent(event));
    snapshot.calendarSettings.google = {
      status: snapshot.calendarSettings.google.status === "connected" ? "connected" : snapshot.calendarSettings.google.status,
      calendarId: "__all__",
      lastSyncAt: ""
    };
    return snapshot;
  }

  function mergeLocalGoogleEvents(baseData, localEvents) {
    const merged = normalizePortalData(baseData);
    const existingKeys = new Set(merged.events.map((event) => `${event.externalCalendarId || ""}::${event.externalId || event.id}`));
    for (const event of localEvents) {
      const normalized = normalizeEvent(event, merged.categories);
      const key = `${normalized.externalCalendarId || ""}::${normalized.externalId || normalized.id}`;
      if (!existingKeys.has(key)) {
        merged.events.push(normalized);
        existingKeys.add(key);
      }
    }
    return merged;
  }

  function loadLocalPortalData() {
    const saved = readJson(storageKeys.data, null);
    if (saved) return normalizePortalData(saved);

    const data = defaultPortalData();
    data.posts = readJson(storageKeys.legacyPosts, []).map((post) => normalizePost(post, data.categories)).filter((post) => post.title && post.body);
    data.customApps = readJson(storageKeys.legacyApps, []).map((app) => normalizeCustomApp(app, data.categories)).filter((app) => app.name && app.path);
    return normalizePortalData(data);
  }

  async function loadServerPortalData() {
    try {
      const response = await fetch(`${apiBase}/api/portal/data`, { cache: "no-store" });
      if (!response.ok) throw new Error("portal data unavailable");
      const payload = await response.json();
      state.serverBacked = true;
      if (payload.data) {
        const localGoogleEvents = state.data.events.filter(isGoogleEvent);
        state.data = mergeLocalGoogleEvents(payload.data, localGoogleEvents);
        writeJson(storageKeys.data, state.data);
      } else {
        saveData();
      }
    } catch (error) {
      state.serverBacked = false;
    }
  }

  function saveData() {
    state.data = normalizePortalData(state.data);
    writeJson(storageKeys.data, state.data);
    if (!state.serverBacked) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const syncedData = portalDataForGit(state.data);
      fetch(`${apiBase}/api/portal/data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: syncedData })
      }).catch(() => {
        state.serverBacked = false;
      });
    }, 180);
  }

  async function fetchJson(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      cache: "no-store",
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "요청에 실패했습니다.");
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function gitResultText(result) {
    if (!result) return "";
    return [
      `$ ${result.command || "git"}`,
      result.stdout || "",
      result.stderr || ""
    ].filter(Boolean).join("\n");
  }

  function renderGit() {
    const branchNode = $("#gitBranch");
    if (!branchNode) return;
    const snapshot = state.git.snapshot;
    const busy = state.git.busy;
    $("#gitRefresh").disabled = busy;
    $("#gitPull").disabled = busy;
    $("#gitPush").disabled = busy;
    $("#gitCommitForm").querySelector("button").disabled = busy;

    if (!snapshot) {
      branchNode.textContent = "-";
      $("#gitCleanState").textContent = busy ? "확인 중" : "-";
      $("#gitLastCommit").textContent = "-";
      $("#gitRemoteOutput").textContent = "";
      $("#gitFileList").innerHTML = empty("상태를 아직 확인하지 않았습니다.");
      $("#gitActionOutput").textContent = state.git.output;
      return;
    }

    if (!snapshot.repo) {
      branchNode.textContent = "-";
      $("#gitCleanState").textContent = "저장소 없음";
      $("#gitLastCommit").textContent = "-";
      $("#gitRemoteOutput").textContent = snapshot.error || "Git 저장소를 찾을 수 없습니다.";
      $("#gitFileList").innerHTML = empty("변경 파일 없음");
      $("#gitActionOutput").textContent = state.git.output;
      return;
    }

    branchNode.textContent = snapshot.branch || "-";
    $("#gitCleanState").textContent = snapshot.clean ? "깨끗함" : `${snapshot.status.length}개 변경`;
    $("#gitLastCommit").textContent = snapshot.lastCommit || "-";
    $("#gitRemoteOutput").textContent = [snapshot.statusBranch, snapshot.remote].filter(Boolean).join("\n\n") || "원격 저장소 없음";
    $("#gitFileList").innerHTML = snapshot.status.length
      ? snapshot.status.map((line) => {
          const code = line.slice(0, 2).trim() || "?";
          const file = line.slice(3).trim() || line;
          return `<div class="git-file-item"><strong>${escapeHtml(code)}</strong><span>${escapeHtml(file)}</span></div>`;
        }).join("")
      : empty("변경 파일 없음");
    $("#gitActionOutput").textContent = state.git.output;
  }

  async function loadGitStatus() {
    state.git.busy = true;
    renderGit();
    try {
      state.git.snapshot = await fetchJson("/api/git/status");
    } catch (error) {
      state.git.snapshot = { repo: false, error: error.message };
    } finally {
      state.git.busy = false;
      renderGit();
    }
  }

  async function runGitAction(action, options = {}) {
    if (action === "push" && !confirm("현재 커밋된 내용을 GitHub로 올릴까요? GitHub 저장소에 데이터가 전송됩니다.")) return;
    if (action === "pull" && !confirm("GitHub의 변경사항을 이 PC로 받을까요? 로컬 파일이 바뀔 수 있습니다.")) return;

    state.git.busy = true;
    state.git.output = "실행 중...";
    renderGit();
    try {
      const payload = await fetchJson("/api/git/action", {
        method: "POST",
        body: JSON.stringify({ action, ...options })
      });
      state.git.snapshot = payload.snapshot || state.git.snapshot;
      state.git.output = gitResultText(payload.result) || "완료";
      if (action === "commit") $("#gitCommitMessage").value = "";
    } catch (error) {
      state.git.snapshot = error.payload?.snapshot || state.git.snapshot;
      state.git.output = gitResultText(error.payload?.result) || error.message;
    } finally {
      state.git.busy = false;
      renderGit();
    }
  }

  function calendarMonthKey() {
    return dateIso(state.calendarMonth).slice(0, 7);
  }

  function googleSyncKey() {
    const calendarId = state.data.calendarSettings.google.calendarId || "__all__";
    return `${calendarId}:${calendarMonthKey()}`;
  }

  function renderGoogleCalendarSelect() {
    const select = $("#googleCalendarSelect");
    if (!select) return;
    const current = state.data.calendarSettings.google.calendarId || "__all__";
    const seen = new Set(["__all__", "primary"]);
    const options = [
      `<option value="__all__">모든 캘린더</option>`,
      `<option value="primary">기본 캘린더</option>`
    ];
    for (const calendar of state.googleCalendar.calendars || []) {
      if (!calendar.id || seen.has(calendar.id)) continue;
      seen.add(calendar.id);
      const suffix = calendar.primary ? " · 기본" : "";
      options.push(`<option value="${escapeHtml(calendar.id)}">${escapeHtml(calendar.name || calendar.id)}${suffix}</option>`);
    }
    select.innerHTML = options.join("");
    select.value = seen.has(current) ? current : "__all__";
    select.disabled = state.googleCalendar.syncing || !state.googleCalendar.connected || state.googleCalendar.needsReconnect;
  }

  function renderGoogleCalendarStatus() {
    const statusNode = $("#googleCalendarStatus");
    if (!statusNode) return;
    const google = state.data.calendarSettings.google;
    const status = state.googleCalendar;
    const lastSync = google.lastSyncAt ? ` · 최근 ${formatDateTime(google.lastSyncAt)}` : "";
    statusNode.textContent = status.syncing ? "동기화 중..." : `${status.message}${lastSync}`;
    const connectButton = $("#googleConnect");
    const syncButton = $("#googleSyncMonth");
    const refreshButton = $("#googleRefreshStatus");
    if (connectButton) {
      connectButton.disabled = status.syncing || !status.configured;
      connectButton.textContent = status.connected ? "다시 연결" : "연결";
    }
    if (syncButton) syncButton.disabled = status.syncing || !status.connected || status.needsReconnect;
    if (refreshButton) refreshButton.disabled = status.syncing;
    renderGoogleCalendarSelect();
  }

  async function refreshGoogleCalendarStatus() {
    try {
      const payload = await fetchJson("/api/calendar/google/status");
      state.googleCalendar = {
        ...state.googleCalendar,
        configured: Boolean(payload.configured),
        connected: Boolean(payload.connected),
        needsReconnect: Boolean(payload.needsReconnect),
        syncing: false,
        message: payload.message || "상태 확인 완료"
      };
      state.data.calendarSettings.google.status = payload.connected && !payload.needsReconnect ? "connected" : payload.configured ? "ready" : "not-configured";
      if (payload.connected && !payload.needsReconnect) {
        await loadGoogleCalendars();
      }
    } catch (error) {
      state.googleCalendar = {
        configured: false,
        connected: false,
        syncing: false,
        needsReconnect: false,
        calendars: state.googleCalendar.calendars,
        syncedMonths: state.googleCalendar.syncedMonths,
        message: "Local Desk 서버에서 Google 상태를 확인하지 못했습니다."
      };
    }
    renderGoogleCalendarStatus();
    maybeAutoSyncGoogleCalendar();
  }

  async function loadGoogleCalendars() {
    try {
      const payload = await fetchJson("/api/calendar/google/calendars");
      state.googleCalendar.calendars = payload.calendars || [];
    } catch (error) {
      state.googleCalendar.message = error.message;
      if (error.payload?.authRequired) state.googleCalendar.needsReconnect = true;
    }
  }

  async function connectGoogleCalendar() {
    try {
      const payload = await fetchJson("/api/calendar/google/auth-url");
      window.open(payload.authUrl, "_blank", "noopener");
      state.googleCalendar.message = "브라우저 승인 대기 중";
      renderGoogleCalendarStatus();
      setTimeout(refreshGoogleCalendarStatus, 5000);
    } catch (error) {
      alert(error.message);
      await refreshGoogleCalendarStatus();
    }
  }

  function mergeGoogleEvents(remoteEvents, pushed) {
    const month = calendarMonthKey();
    const selectedCalendarId = state.data.calendarSettings.google.calendarId || "__all__";
    const eventKey = (event) => `${event.externalCalendarId || "primary"}::${event.externalId || ""}`;
    const pushedByLocalId = new Map((pushed || []).map((item) => [item.localId, item.event]));
    for (const event of state.data.events) {
      const pushedEvent = pushedByLocalId.get(event.id);
      if (!pushedEvent) continue;
      event.source = "google";
      event.externalId = pushedEvent.externalId;
      event.externalCalendarId = pushedEvent.externalCalendarId || "primary";
      event.externalCalendarName = pushedEvent.externalCalendarName || "";
      event.syncStatus = "synced";
      event.updatedAt = Date.now();
    }

    const remoteIds = new Set((remoteEvents || []).filter((event) => event.externalId).map(eventKey));
    state.data.events = state.data.events.filter((event) => {
      if (event.source !== "google" || !event.date.startsWith(month) || !event.externalId) return true;
      if (selectedCalendarId !== "__all__" && (event.externalCalendarId || "primary") !== selectedCalendarId) return true;
      return remoteIds.has(eventKey(event));
    });

    for (const remote of remoteEvents || []) {
      if (!remote.externalId) continue;
      const existing = state.data.events.find((event) => event.source === "google" && eventKey(event) === eventKey(remote));
      if (existing) {
        Object.assign(existing, {
          ...remote,
          id: existing.id,
          categoryId: existing.categoryId || remote.categoryId,
          tags: existing.tags?.length ? existing.tags : remote.tags
        });
      } else {
        state.data.events.push(remote);
      }
    }
  }

  function maybeAutoSyncGoogleCalendar() {
    if (!state.googleCalendar.connected || state.googleCalendar.syncing) return;
    if (state.googleCalendar.needsReconnect) return;
    const syncKey = googleSyncKey();
    if (state.googleCalendar.syncedMonths.has(syncKey)) return;
    syncGoogleCalendarMonth({ pushLocal: false, silent: true });
  }

  async function syncGoogleCalendarMonth(options = {}) {
    const pushLocal = Object.prototype.hasOwnProperty.call(options, "pushLocal")
      ? Boolean(options.pushLocal)
      : Boolean($("#googlePushLocal")?.checked);
    const silent = Boolean(options.silent);
    const google = state.data.calendarSettings.google;
    const month = calendarMonthKey();
    state.googleCalendar.syncing = true;
    state.googleCalendar.message = `${month} 동기화 중`;
    renderGoogleCalendarStatus();
    try {
      const payload = await fetchJson("/api/calendar/google/sync", {
        method: "POST",
        body: JSON.stringify({
          calendarId: google.calendarId || "primary",
          month,
          pushLocal,
          events: state.data.events
        })
      });
      state.googleCalendar.calendars = payload.calendars || state.googleCalendar.calendars;
      mergeGoogleEvents(payload.events, payload.pushed);
      google.status = "connected";
      google.calendarId = payload.calendarId || "__all__";
      google.lastSyncAt = payload.lastSyncAt || new Date().toISOString();
      state.googleCalendar = {
        ...state.googleCalendar,
        configured: true,
        connected: true,
        needsReconnect: false,
        syncing: false,
        message: `동기화 완료: ${payload.events?.length || 0}개`
      };
      state.googleCalendar.syncedMonths.add(googleSyncKey());
      saveData();
      renderAll();
    } catch (error) {
      state.googleCalendar.syncing = false;
      state.googleCalendar.connected = !error.payload?.authRequired && state.googleCalendar.connected;
      state.googleCalendar.message = error.message;
      if (!silent) alert(error.message);
      renderGoogleCalendarStatus();
    }
  }

  function formatDateTime(value) {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  }

  function formatDateLabel(iso) {
    if (!iso) return "날짜 없음";
    const [year, month, day] = iso.split("-").map(Number);
    return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", weekday: "short" }).format(new Date(year, month - 1, day));
  }

  function todayLabel() {
    return new Intl.DateTimeFormat("ko-KR", {
      weekday: "long",
      month: "long",
      day: "numeric"
    }).format(new Date());
  }

  function empty(text) {
    return `<div class="empty compact-empty">${escapeHtml(text)}</div>`;
  }

  function categories(type) {
    return state.data.categories[type] || [];
  }

  function categoryName(type, id) {
    return categories(type).find((category) => category.id === id)?.name || "미분류";
  }

  function buildCategoryTree(type) {
    const children = new Map();
    const roots = [];
    for (const category of categories(type)) {
      if (!children.has(category.id)) children.set(category.id, []);
    }
    for (const category of categories(type)) {
      if (category.parentId && children.has(category.parentId)) {
        children.get(category.parentId).push(category);
      } else {
        roots.push(category);
      }
    }
    return { roots, children };
  }

  function descendantCategoryIds(type, categoryId) {
    const tree = buildCategoryTree(type);
    const ids = new Set([categoryId]);
    function visit(id) {
      for (const child of tree.children.get(id) || []) {
        ids.add(child.id);
        visit(child.id);
      }
    }
    visit(categoryId);
    return ids;
  }

  function itemInCategory(type, item, categoryId) {
    if (categoryId === "all") return true;
    return descendantCategoryIds(type, categoryId).has(item.categoryId);
  }

  function categoryCount(type, categoryId, items) {
    if (categoryId === "all") return items.length;
    const ids = descendantCategoryIds(type, categoryId);
    return items.filter((item) => ids.has(item.categoryId)).length;
  }

  function treeHtml(type, nodes, depth, selectedId, items) {
    const tree = buildCategoryTree(type);
    return nodes.map((category) => {
      const count = categoryCount(type, category.id, items);
      return `
        <button class="tree-item ${selectedId === category.id ? "active" : ""}" type="button" data-category-type="${type}" data-category-filter="${escapeHtml(category.id)}" style="--depth:${depth}">
          <span>${escapeHtml(category.name)}</span>
          <small>${count}</small>
        </button>
        ${treeHtml(type, tree.children.get(category.id) || [], depth + 1, selectedId, items)}
      `;
    }).join("");
  }

  function renderCategoryTree(type) {
    const prefix = type === "posts" ? "post" : type === "todos" ? "todo" : type === "links" ? "link" : "app";
    const filter = state.filters[type];
    const items = type === "posts" ? state.data.posts : type === "todos" ? state.data.todos : type === "links" ? state.data.links : allApps();
    const statusItems = items.filter((item) => statusMatches(type, item, filter.status));
    const tree = buildCategoryTree(type);
    const title = { posts: "게시판 전체", apps: "기능 전체", todos: "할 일 전체", links: "홈페이지 전체" }[type] || "전체";
    $(`#${prefix}CategoryTree`).innerHTML = `
      <button class="tree-item ${filter.categoryId === "all" ? "active" : ""}" type="button" data-category-type="${type}" data-category-filter="all" style="--depth:0">
        <span>${title}</span>
        <small>${statusItems.length}</small>
      </button>
      ${treeHtml(type, tree.roots, 0, filter.categoryId, statusItems)}
    `;
  }

  function categoryOptions(type, selectedId, options = {}) {
    const tree = buildCategoryTree(type);
    const rows = [];
    function visit(nodes, depth) {
      for (const category of nodes) {
        if (category.id !== options.excludeId) {
          rows.push({ category, depth });
          visit(tree.children.get(category.id) || [], depth + 1);
        }
      }
    }
    visit(tree.roots, 0);
    const head = options.rootLabel
      ? `<option value="" ${!selectedId ? "selected" : ""}>${escapeHtml(options.rootLabel)}</option>`
      : "";
    return head + rows.map(({ category, depth }) => {
      const prefix = depth ? `${"　".repeat(depth)}ㄴ ` : "";
      return `<option value="${escapeHtml(category.id)}" ${selectedId === category.id ? "selected" : ""}>${prefix}${escapeHtml(category.name)}</option>`;
    }).join("");
  }

  function renderCategoryControls() {
    $("#postCategory").innerHTML = categoryOptions("posts", $("#postCategory").value || "post-memo");
    $("#postCategoryParent").innerHTML = categoryOptions("posts", "", { rootLabel: "상위 없음" });
    $("#appCategory").innerHTML = categoryOptions("apps", $("#appCategory").value || "app-tools");
    $("#appCategoryParent").innerHTML = categoryOptions("apps", "", { rootLabel: "상위 없음" });
    $("#todoCategory").innerHTML = categoryOptions("todos", $("#todoCategory").value || "todo-work");
    $("#todoCategoryParent").innerHTML = categoryOptions("todos", "", { rootLabel: "상위 없음" });
    $("#linkCategory").innerHTML = categoryOptions("links", $("#linkCategory").value || "link-work");
    $("#linkCategoryParent").innerHTML = categoryOptions("links", "", { rootLabel: "상위 없음" });
    $("#eventCategory").innerHTML = categoryOptions("events", $("#eventCategory").value || "event-work");
  }

  function renderTags(tags) {
    const normalized = normalizeTags(tags);
    if (!normalized.length) return "";
    return `<div class="item-tags">${normalized.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>`;
  }

  function tagCounts(items) {
    const counts = new Map();
    for (const item of items) {
      for (const tag of normalizeTags(item.tags)) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  function renderTagFilters(type) {
    const prefix = type === "posts" ? "post" : type === "todos" ? "todo" : type === "links" ? "link" : "app";
    const filter = state.filters[type];
    const items = type === "posts" ? state.data.posts : type === "todos" ? state.data.todos : type === "links" ? state.data.links : allApps();
    const tags = tagCounts(items.filter((item) => statusMatches(type, item, filter.status)));
    const clear = `<button class="tag-filter ${!filter.tag ? "active" : ""}" type="button" data-tag-type="${type}" data-tag-filter="">전체</button>`;
    const buttons = tags.map(([tag, count]) => `
      <button class="tag-filter ${filter.tag === tag ? "active" : ""}" type="button" data-tag-type="${type}" data-tag-filter="${escapeHtml(tag)}">
        #${escapeHtml(tag)} <small>${count}</small>
      </button>
    `).join("");
    $(`#${prefix}TagFilters`).innerHTML = clear + buttons;
  }

  function statusMatches(type, item, status) {
    if (status === "all") return true;
    if (type === "todos") {
      if (status === "open") return item.status !== "done";
      return item.status === status;
    }
    return item.status === status;
  }

  function filteredItems(type, items) {
    const filter = state.filters[type];
    const keyword = String(filter.keyword || "").trim().toLowerCase();
    return items
      .filter((item) => statusMatches(type, item, filter.status))
      .filter((item) => itemInCategory(type, item, filter.categoryId))
      .filter((item) => !filter.tag || normalizeTags(item.tags).includes(filter.tag))
      .filter((item) => {
        if (!keyword) return true;
        return [
          item.title,
          item.name,
          item.body,
          item.notes,
          item.description,
          item.url,
          item.path,
          item.dueDate,
          categoryName(type, item.categoryId),
          ...(item.tags || [])
        ].join(" ").toLowerCase().includes(keyword);
      });
  }

  function hydrateApp(app, isCustom) {
    const meta = state.data.appMeta[app.id] || {};
    const overrides = meta.overrides || {};
    return {
      ...app,
      name: overrides.name || app.name,
      type: overrides.type || app.type || "page",
      path: overrides.path || app.path || "#",
      description: overrides.description || app.description || "",
      initials: (overrides.initials || app.initials || app.name?.slice(0, 2) || "AP").toUpperCase(),
      categoryId: meta.categoryId || app.categoryId || "app-tools",
      tags: normalizeTags(meta.tags?.length ? meta.tags : app.tags),
      status: normalizeVisibility(meta.status || app.status),
      favorite: Boolean(meta.favorite ?? app.favorite),
      isCustom
    };
  }

  function allApps() {
    return [
      ...baseApps.map((app) => hydrateApp(app, false)),
      ...state.data.customApps.map((app) => hydrateApp(app, true))
    ];
  }

  function visibilityBadge(status) {
    return status !== "active" ? `<span class="status-badge ${status}">${visibilityLabels[status]}</span>` : "";
  }

  function todoBadge(status) {
    return `<span class="status-badge ${status}">${todoStatusLabels[status] || status}</span>`;
  }

  function compactLink(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (error) {
      return url;
    }
  }

  function renderMiniItem(title, meta, href) {
    const content = `
      <span>${escapeHtml(title)}</span>
      ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
    `;
    if (href) return `<a class="mini-item" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${content}</a>`;
    return `<div class="mini-item">${content}</div>`;
  }

  function renderAppCard(app, options = {}) {
    const href = app.path || "#";
    const target = app.type === "external" ? ' target="_blank" rel="noreferrer"' : "";
    if (options.compact) {
      return renderMiniItem(app.name, categoryName("apps", app.categoryId), href);
    }
    return `
      <article class="app-card" data-app-id="${escapeHtml(app.id)}">
        <div class="app-top">
          <span class="app-icon">${escapeHtml(app.initials)}</span>
          <span class="app-type">${escapeHtml(app.type || "page")}</span>
        </div>
        <h3>${escapeHtml(app.name)} ${visibilityBadge(app.status)}</h3>
        <p>${escapeHtml(app.description || "")}</p>
        <div class="item-meta-line">
          <span>${escapeHtml(categoryName("apps", app.categoryId))}</span>
          ${app.favorite ? "<span>홈 표시</span>" : ""}
        </div>
        ${renderTags(app.tags)}
        <span class="app-path">${escapeHtml(href)}</span>
        <div class="post-actions">
          <a class="text-button tiny link-button" href="${escapeHtml(href)}"${target}>열기</a>
          <button class="text-button tiny" type="button" data-edit-app="${escapeHtml(app.id)}">관리</button>
          ${app.status === "active"
            ? `<button class="text-button tiny" type="button" data-app-status="${escapeHtml(app.id)}" data-status="archived">보관</button>
               <button class="text-button tiny" type="button" data-app-status="${escapeHtml(app.id)}" data-status="hidden">숨김</button>`
            : `<button class="text-button tiny" type="button" data-app-status="${escapeHtml(app.id)}" data-status="active">다시 표시</button>`}
          ${app.isCustom ? `<button class="delete-button" type="button" data-remove-custom-app="${escapeHtml(app.id)}">목록 제거</button>` : ""}
        </div>
      </article>
    `;
  }

  function renderPostCard(post, options = {}) {
    if (options.compact) {
      return renderMiniItem(post.title, categoryName("posts", post.categoryId));
    }
    return `
      <article class="post-card" data-post-id="${escapeHtml(post.id)}">
        <div class="post-meta">
          <span>${escapeHtml(categoryName("posts", post.categoryId))}</span>
          <time>${escapeHtml(formatDateTime(post.updatedAt || post.createdAt))}</time>
        </div>
        <h3>${escapeHtml(post.title)} ${visibilityBadge(post.status)}</h3>
        <p>${escapeHtml(post.body)}</p>
        ${renderTags(post.tags)}
        <div class="post-actions">
          <button class="text-button tiny" type="button" data-edit-post="${escapeHtml(post.id)}">수정</button>
          ${post.status === "active"
            ? `<button class="text-button tiny" type="button" data-post-status="${escapeHtml(post.id)}" data-status="archived">보관</button>
               <button class="text-button tiny" type="button" data-post-status="${escapeHtml(post.id)}" data-status="hidden">숨김</button>`
            : `<button class="text-button tiny" type="button" data-post-status="${escapeHtml(post.id)}" data-status="active">다시 표시</button>`}
          <button class="delete-button" type="button" data-delete-post="${escapeHtml(post.id)}">삭제</button>
        </div>
      </article>
    `;
  }

  function getSubTodos(parentId) {
    return state.data.todos.filter((t) => t.parentId === parentId);
  }

  function allSubsDone(parentId) {
    const subs = getSubTodos(parentId);
    return subs.length === 0 || subs.every((s) => s.status === "done");
  }

  function isFullyDone(todo) {
    return todo.status === "done" && allSubsDone(todo.id);
  }

  function renderSubTodoCard(sub) {
    const due = sub.dueDate ? formatDateLabel(sub.dueDate) : "";
    return `
      <div class="sub-todo ${sub.status === "done" ? "done" : ""}">
        <div class="sub-todo-content">
          <span class="sub-todo-title">${escapeHtml(sub.title)}</span>
          ${due ? `<small>${escapeHtml(due)}</small>` : ""}
        </div>
        <div class="sub-todo-actions">
          <button class="text-button tiny" type="button" data-todo-status="${escapeHtml(sub.id)}" data-status="${sub.status === "done" ? "todo" : "done"}">${sub.status === "done" ? "되돌리기" : "완료"}</button>
          <button class="text-button tiny" type="button" data-edit-todo="${escapeHtml(sub.id)}">수정</button>
          <button class="delete-button" type="button" data-delete-todo="${escapeHtml(sub.id)}">삭제</button>
        </div>
      </div>
    `;
  }

  function renderTodoCard(todo, options = {}) {
    const due = todo.dueDate ? formatDateLabel(todo.dueDate) : "마감 없음";
    if (options.compact) {
      return `
        <div class="mini-item todo-mini ${todo.status === "done" ? "done" : ""}">
          <span>${escapeHtml(todo.title)}</span>
          <small>${escapeHtml(due)} · ${escapeHtml(todoStatusLabels[todo.status])}</small>
        </div>
      `;
    }
    const subs = getSubTodos(todo.id);
    const subsHtml = subs.length > 0
      ? `<div class="sub-todo-list">
           <p class="sub-todo-header">세부 할일 (${subs.filter((s) => s.status === "done").length}/${subs.length})</p>
           ${subs.sort((a, b) => (a.status === "done") - (b.status === "done") || a.order - b.order).map(renderSubTodoCard).join("")}
         </div>`
      : "";
    const canComplete = allSubsDone(todo.id);
    const completeButton = todo.status === "done"
      ? `<button class="text-button tiny" type="button" data-todo-status="${escapeHtml(todo.id)}" data-status="todo">되돌리기</button>`
      : canComplete
        ? `<button class="text-button tiny" type="button" data-todo-status="${escapeHtml(todo.id)}" data-status="done">완료</button>`
        : `<button class="text-button tiny disabled" type="button" title="세부 할일을 먼저 완료하세요" disabled>완료</button>`;
    return `
      <article class="post-card todo-card" data-todo-id="${escapeHtml(todo.id)}">
        <div class="post-meta">
          <span>${escapeHtml(categoryName("todos", todo.categoryId))}</span>
          <time>${escapeHtml(due)}</time>
        </div>
        <h3>${escapeHtml(todo.title)} ${todoBadge(todo.status)}</h3>
        <p>${escapeHtml(todo.notes || "")}</p>
        <div class="item-meta-line">
          <span>우선순위 ${escapeHtml(priorityLabels[todo.priority])}</span>
        </div>
        ${renderTags(todo.tags)}
        ${subsHtml}
        <div class="post-actions">
          ${completeButton}
          <button class="text-button tiny" type="button" data-add-subtodo="${escapeHtml(todo.id)}">세부 추가</button>
          <button class="text-button tiny" type="button" data-edit-todo="${escapeHtml(todo.id)}">수정</button>
          <button class="delete-button" type="button" data-delete-todo="${escapeHtml(todo.id)}">삭제</button>
        </div>
      </article>
    `;
  }

  function renderLinkCard(link, options = {}) {
    if (options.compact) {
      return renderMiniItem(link.name, compactLink(link.url), link.url);
    }
    return `
      <article class="post-card link-card" data-link-id="${escapeHtml(link.id)}">
        <div class="post-meta">
          <span>${escapeHtml(categoryName("links", link.categoryId))}</span>
          <span>${link.favorite ? "홈 표시" : ""}</span>
        </div>
        <h3>${escapeHtml(link.name)} ${visibilityBadge(link.status)}</h3>
        <p>${escapeHtml(link.description || compactLink(link.url))}</p>
        ${renderTags(link.tags)}
        <span class="app-path">${escapeHtml(link.url)}</span>
        <div class="post-actions">
          <a class="text-button tiny link-button" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">열기</a>
          <button class="text-button tiny" type="button" data-edit-link="${escapeHtml(link.id)}">수정</button>
          ${link.status === "active"
            ? `<button class="text-button tiny" type="button" data-link-status="${escapeHtml(link.id)}" data-status="archived">보관</button>
               <button class="text-button tiny" type="button" data-link-status="${escapeHtml(link.id)}" data-status="hidden">숨김</button>`
            : `<button class="text-button tiny" type="button" data-link-status="${escapeHtml(link.id)}" data-status="active">다시 표시</button>`}
          <button class="delete-button" type="button" data-delete-link="${escapeHtml(link.id)}">삭제</button>
        </div>
      </article>
    `;
  }

  function renderEventMini(event) {
    const time = [event.startTime, event.endTime].filter(Boolean).join("-");
    return renderMiniItem(event.title, time || categoryName("events", event.categoryId));
  }

  function renderHome() {
    const today = todayIso();
    const favoriteApps = allApps().filter((app) => app.status === "active" && app.favorite).slice(0, 6);
    const favoriteLinks = state.data.links.filter((link) => link.status === "active" && link.favorite).slice(0, 8);
    const todayTodos = state.data.todos
      .filter((todo) => !todo.parentId && todo.status !== "done" && (!todo.dueDate || todo.dueDate <= today))
      .sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))
      .slice(0, 6);
    const todayEvents = state.data.events.filter((event) => event.date === today).sort((a, b) => a.startTime.localeCompare(b.startTime));
    const recentPosts = [...state.data.posts]
      .filter((post) => post.status === "active")
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .slice(0, 4);

    $("#homeApps").innerHTML = favoriteApps.map((app) => renderAppCard(app, { compact: true })).join("") || empty("즐겨찾기 기능이 없습니다.");
    $("#homeLinks").innerHTML = favoriteLinks.map((link) => renderLinkCard(link, { compact: true })).join("") || empty("즐겨찾기 홈페이지가 없습니다.");
    $("#homeTodos").innerHTML = todayTodos.map((todo) => renderTodoCard(todo, { compact: true })).join("") || empty("오늘 할 일이 없습니다.");
    $("#homeTodayEvents").innerHTML = todayEvents.map(renderEventMini).join("") || empty("오늘 일정이 없습니다.");
    $("#recentPosts").innerHTML = recentPosts.map((post) => renderPostCard(post, { compact: true })).join("") || empty("최근 글이 없습니다.");
    renderMiniCalendar();
  }

  function renderApps() {
    const apps = filteredItems("apps", allApps());
    $("#appGrid").innerHTML = apps.map((app) => renderAppCard(app)).join("") || empty("조건에 맞는 기능이 없습니다.");
    renderCategoryTree("apps");
    renderTagFilters("apps");
  }

  function renderPosts() {
    const posts = filteredItems("posts", state.data.posts)
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    $("#postList").innerHTML = posts.map((post) => renderPostCard(post)).join("") || empty("조건에 맞는 글이 없습니다.");
    renderCategoryTree("posts");
    renderTagFilters("posts");
  }

  function renderTodos() {
    const allTodos = filteredItems("todos", state.data.todos);
    const topLevel = allTodos.filter((t) => !t.parentId);
    const sortFn = (a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.order - b.order;
    const active = topLevel.filter((t) => !isFullyDone(t)).sort(sortFn);
    const done = topLevel.filter((t) => isFullyDone(t)).sort(sortFn);

    let html = "";
    if (active.length > 0) {
      html += active.map((todo) => renderTodoCard(todo)).join("");
    }
    if (done.length > 0) {
      html += `
        <details class="done-section">
          <summary class="done-section-header">완료 (${done.length})</summary>
          <div class="done-section-list">${done.map((todo) => renderTodoCard(todo)).join("")}</div>
        </details>
      `;
    }
    $("#todoList").innerHTML = html || empty("조건에 맞는 할 일이 없습니다.");
    renderCategoryTree("todos");
    renderTagFilters("todos");
  }

  function renderLinks() {
    const links = filteredItems("links", state.data.links)
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name));
    $("#linkList").innerHTML = links.map((link) => renderLinkCard(link)).join("") || empty("조건에 맞는 홈페이지가 없습니다.");
    renderCategoryTree("links");
    renderTagFilters("links");
  }

  function getKoreanHolidays(year) {
    const fixed = [
      [1, 1], [3, 1], [5, 5], [6, 6], [8, 15], [10, 3], [10, 9], [12, 25]
    ];
    const holidays = new Set();
    for (const [m, d] of fixed) {
      holidays.add(`${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    return holidays;
  }

  function getDayClass(day) {
    const dow = day.getDay();
    const iso = dateIso(day);
    const holidays = getKoreanHolidays(day.getFullYear());
    if (dow === 0 || holidays.has(iso)) return "holiday";
    if (dow === 6) return "saturday";
    return "";
  }

  function monthMatrix(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    const first = new Date(year, month, 1);
    const start = new Date(year, month, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      return day;
    });
  }

  function eventsByDate() {
    const map = new Map();
    for (const event of state.data.events) {
      if (!map.has(event.date)) map.set(event.date, []);
      map.get(event.date).push(event);
    }
    return map;
  }

  function renderMiniCalendar() {
    const today = todayIso();
    const eventMap = eventsByDate();
    const days = monthMatrix(new Date());
    $("#homeCalendarGrid").innerHTML = days.map((day) => {
      const iso = dateIso(day);
      const muted = day.getMonth() !== new Date().getMonth() ? "muted" : "";
      const hasEvent = eventMap.has(iso) ? "has-event" : "";
      const dayClass = getDayClass(day);
      return `<span class="calendar-mini-day ${muted} ${hasEvent} ${dayClass} ${iso === today ? "today" : ""}">${day.getDate()}</span>`;
    }).join("");
  }

  function renderCalendar() {
    const month = state.calendarMonth;
    const today = todayIso();
    const eventMap = eventsByDate();
    $("#calendarMonthLabel").textContent = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long" }).format(month);
    $("#calendarGrid").innerHTML = monthMatrix(month).map((day) => {
      const iso = dateIso(day);
      const events = (eventMap.get(iso) || []).sort((a, b) => a.startTime.localeCompare(b.startTime));
      const muted = day.getMonth() !== month.getMonth() ? "muted" : "";
      return `
        <div class="calendar-day ${muted} ${getDayClass(day)} ${iso === today ? "today" : ""}">
          <div class="calendar-day-number">${day.getDate()}</div>
          ${events.slice(0, 3).map((event) => `<button class="calendar-event ${event.source === "google" ? "google-event" : ""}" type="button" data-delete-event="${escapeHtml(event.id)}">${escapeHtml(event.startTime ? `${event.startTime} ${event.title}` : event.title)}</button>`).join("")}
          ${events.length > 3 ? `<small>+${events.length - 3}</small>` : ""}
        </div>
      `;
    }).join("");
    const list = [...state.data.events]
      .filter((event) => event.date.slice(0, 7) === dateIso(month).slice(0, 7))
      .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
    $("#eventList").innerHTML = list.map((event) => `
      <div class="mini-item">
        <span>${escapeHtml(event.title)}</span>
        <small>${escapeHtml(formatDateLabel(event.date))} ${escapeHtml(event.startTime || "")}${event.source === "google" ? ` · ${escapeHtml(event.externalCalendarName || "Google")}` : ""}</small>
        <button class="text-button tiny" type="button" data-delete-event="${escapeHtml(event.id)}">삭제</button>
      </div>
    `).join("") || empty("이번 달 일정이 없습니다.");
    renderGoogleCalendarStatus();
  }

  function syncFilterControls() {
    $("#postSearch").value = state.filters.posts.keyword;
    $("#appSearch").value = state.filters.apps.keyword;
    $("#todoSearch").value = state.filters.todos.keyword;
    $("#linkSearch").value = state.filters.links.keyword;
    $("#postStatusFilter").value = state.filters.posts.status;
    $("#appStatusFilter").value = state.filters.apps.status;
    $("#todoStatusFilter").value = state.filters.todos.status;
    $("#linkStatusFilter").value = state.filters.links.status;
  }

  function renderCategoryControls() {
    $("#postCategory").innerHTML = categoryOptions("posts", $("#postCategory").value || "post-memo");
    $("#postCategoryParent").innerHTML = categoryOptions("posts", "", { rootLabel: "상위 없음" });
    $("#appCategory").innerHTML = categoryOptions("apps", $("#appCategory").value || "app-tools");
    $("#appCategoryParent").innerHTML = categoryOptions("apps", "", { rootLabel: "상위 없음" });
    $("#todoCategory").innerHTML = categoryOptions("todos", $("#todoCategory").value || "todo-work");
    $("#todoCategoryParent").innerHTML = categoryOptions("todos", "", { rootLabel: "상위 없음" });
    $("#linkCategory").innerHTML = categoryOptions("links", $("#linkCategory").value || "link-work");
    $("#linkCategoryParent").innerHTML = categoryOptions("links", "", { rootLabel: "상위 없음" });
    $("#eventCategory").innerHTML = categoryOptions("events", $("#eventCategory").value || "event-work");
  }

  function renderAll() {
    syncFilterControls();
    renderCategoryControls();
    renderHome();
    renderApps();
    renderPosts();
    renderTodos();
    renderLinks();
    renderCalendar();
    renderGit();
  }

  function addCategory(type, name, parentId) {
    const trimmed = name.trim();
    if (!trimmed) return;
    state.data.categories[type].push({ id: makeId(`${type}-cat`), name: trimmed, parentId: parentId || "" });
    saveData();
    renderAll();
  }

  function resetPostForm() {
    $("#postEditingId").value = "";
    $("#boardHeading").textContent = "글 작성";
    $("#savePostButton").textContent = "저장";
    $("#cancelPostEdit").hidden = true;
    $("#postForm").reset();
    renderCategoryControls();
    $("#postStatus").value = "active";
  }

  function editPost(id) {
    const post = state.data.posts.find((item) => item.id === id);
    if (!post) return;
    $("#postEditingId").value = post.id;
    $("#boardHeading").textContent = "글 수정";
    $("#savePostButton").textContent = "수정 저장";
    $("#cancelPostEdit").hidden = false;
    $("#postTitle").value = post.title;
    $("#postCategory").value = post.categoryId;
    $("#postTags").value = tagInput(post.tags);
    $("#postStatus").value = post.status;
    $("#postBody").value = post.body;
    setSection("board");
  }

  function savePostFromForm() {
    const id = $("#postEditingId").value;
    const payload = {
      title: $("#postTitle").value.trim(),
      body: $("#postBody").value.trim(),
      categoryId: $("#postCategory").value,
      tags: normalizeTags($("#postTags").value),
      status: normalizeVisibility($("#postStatus").value),
      updatedAt: Date.now()
    };
    if (!payload.title || !payload.body) return;
    if (id) {
      const post = state.data.posts.find((item) => item.id === id);
      if (post) Object.assign(post, payload);
    } else {
      state.data.posts.push({ id: makeId("post"), createdAt: Date.now(), ...payload });
    }
    saveData();
    resetPostForm();
    renderAll();
  }

  function resetTodoForm() {
    $("#todoEditingId").value = "";
    $("#todoParentId").value = "";
    $("#todoParentHint").hidden = true;
    $("#todosHeading").textContent = "할 일 추가";
    $("#saveTodoButton").textContent = "저장";
    $("#cancelTodoEdit").hidden = true;
    $("#todoForm").reset();
    renderCategoryControls();
    $("#todoStatus").value = "todo";
    $("#todoPriority").value = "normal";
  }

  function startSubTodo(parentId) {
    const parent = state.data.todos.find((t) => t.id === parentId);
    if (!parent) return;
    resetTodoForm();
    $("#todoParentId").value = parentId;
    $("#todoParentHint").hidden = false;
    $("#todoParentName").textContent = parent.title;
    $("#todosHeading").textContent = "세부 할일 추가";
    $("#todoCategory").value = parent.categoryId;
    setSection("todos");
    $("#todoTitle").focus();
  }

  function editTodo(id) {
    const todo = state.data.todos.find((item) => item.id === id);
    if (!todo) return;
    $("#todoEditingId").value = todo.id;
    $("#todoParentId").value = todo.parentId || "";
    if (todo.parentId) {
      const parent = state.data.todos.find((t) => t.id === todo.parentId);
      $("#todoParentHint").hidden = false;
      $("#todoParentName").textContent = parent ? parent.title : "";
    } else {
      $("#todoParentHint").hidden = true;
    }
    $("#todosHeading").textContent = "할 일 수정";
    $("#saveTodoButton").textContent = "수정 저장";
    $("#cancelTodoEdit").hidden = false;
    $("#todoTitle").value = todo.title;
    $("#todoCategory").value = todo.categoryId;
    $("#todoDueDate").value = todo.dueDate;
    $("#todoPriority").value = todo.priority;
    $("#todoStatus").value = todo.status;
    $("#todoTags").value = tagInput(todo.tags);
    $("#todoNotes").value = todo.notes;
    setSection("todos");
  }

  function saveTodoFromForm() {
    const id = $("#todoEditingId").value;
    const parentId = $("#todoParentId").value || "";
    const payload = {
      title: $("#todoTitle").value.trim(),
      categoryId: $("#todoCategory").value,
      dueDate: $("#todoDueDate").value,
      priority: normalizePriority($("#todoPriority").value),
      status: normalizeTodoStatus($("#todoStatus").value),
      tags: normalizeTags($("#todoTags").value),
      notes: $("#todoNotes").value.trim(),
      updatedAt: Date.now()
    };
    if (!payload.title) return;
    if (id) {
      const todo = state.data.todos.find((item) => item.id === id);
      if (todo) Object.assign(todo, payload);
    } else {
      state.data.todos.push({ id: makeId("todo"), parentId, order: Date.now(), createdAt: Date.now(), ...payload });
    }
    saveData();
    resetTodoForm();
    renderAll();
  }

  function resetLinkForm() {
    $("#linkEditingId").value = "";
    $("#linksHeading").textContent = "홈페이지 추가";
    $("#saveLinkButton").textContent = "저장";
    $("#cancelLinkEdit").hidden = true;
    $("#linkForm").reset();
    renderCategoryControls();
  }

  function editLink(id) {
    const link = state.data.links.find((item) => item.id === id);
    if (!link) return;
    $("#linkEditingId").value = link.id;
    $("#linksHeading").textContent = "홈페이지 수정";
    $("#saveLinkButton").textContent = "수정 저장";
    $("#cancelLinkEdit").hidden = false;
    $("#linkName").value = link.name;
    $("#linkUrl").value = link.url;
    $("#linkCategory").value = link.categoryId;
    $("#linkFavorite").checked = link.favorite;
    $("#linkTags").value = tagInput(link.tags);
    $("#linkDescription").value = link.description;
    setSection("links");
  }

  function saveLinkFromForm() {
    const id = $("#linkEditingId").value;
    const payload = {
      name: $("#linkName").value.trim(),
      url: $("#linkUrl").value.trim(),
      categoryId: $("#linkCategory").value,
      favorite: $("#linkFavorite").checked,
      tags: normalizeTags($("#linkTags").value),
      description: $("#linkDescription").value.trim(),
      status: "active",
      updatedAt: Date.now()
    };
    if (!payload.name || !payload.url) return;
    if (id) {
      const link = state.data.links.find((item) => item.id === id);
      if (link) Object.assign(link, payload, { status: link.status });
    } else {
      state.data.links.push({ id: makeId("link"), createdAt: Date.now(), ...payload });
    }
    saveData();
    resetLinkForm();
    renderAll();
  }

  function resetAppForm() {
    $("#appEditingId").value = "";
    $("#appDialogTitle").textContent = "기능 추가";
    $("#addAppForm").querySelector(".primary-button").textContent = "추가";
    $("#cancelAppEdit").hidden = true;
    $("#addAppForm").reset();
    renderCategoryControls();
    $("#appStatus").value = "active";
    $("#appFavorite").checked = false;
  }

  function appById(appId) {
    return allApps().find((app) => app.id === appId);
  }

  function openAppDialog(appId) {
    resetAppForm();
    if (appId) {
      const app = appById(appId);
      if (!app) return;
      $("#appEditingId").value = app.id;
      $("#appDialogTitle").textContent = "기능 관리";
      $("#addAppForm").querySelector(".primary-button").textContent = "저장";
      $("#cancelAppEdit").hidden = false;
      $("#appName").value = app.name;
      $("#appType").value = app.type;
      $("#appPath").value = app.path;
      $("#appDescription").value = app.description || "";
      $("#appCategory").value = app.categoryId;
      $("#appTags").value = tagInput(app.tags);
      $("#appStatus").value = app.status;
      $("#appFavorite").checked = app.favorite;
    }
    const dialog = $("#addAppDialog");
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeAppDialog() {
    const dialog = $("#addAppDialog");
    if (dialog.close && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function saveAppFromForm() {
    const editingId = $("#appEditingId").value;
    const payload = {
      name: $("#appName").value.trim(),
      type: $("#appType").value,
      path: $("#appPath").value.trim(),
      description: $("#appDescription").value.trim(),
      initials: $("#appName").value.trim().slice(0, 2).toUpperCase(),
      categoryId: $("#appCategory").value,
      tags: normalizeTags($("#appTags").value),
      status: normalizeVisibility($("#appStatus").value),
      favorite: $("#appFavorite").checked,
      updatedAt: Date.now()
    };
    if (!payload.name || !payload.path) return;
    if (!editingId) {
      state.data.customApps.push({ id: makeId("custom"), createdAt: Date.now(), ...payload });
    } else if (baseAppIds.has(editingId)) {
      state.data.appMeta[editingId] = {
        categoryId: payload.categoryId,
        tags: payload.tags,
        status: payload.status,
        favorite: payload.favorite,
        overrides: {
          name: payload.name,
          type: payload.type,
          path: payload.path,
          description: payload.description,
          initials: payload.initials
        }
      };
    } else {
      const app = state.data.customApps.find((item) => item.id === editingId);
      if (app) Object.assign(app, payload);
    }
    saveData();
    resetAppForm();
    closeAppDialog();
    renderAll();
  }

  function updateAppStatus(appId, status) {
    const normalized = normalizeVisibility(status);
    if (baseAppIds.has(appId)) {
      const app = appById(appId);
      state.data.appMeta[appId] = {
        ...(state.data.appMeta[appId] || normalizeMeta({}, appId)),
        categoryId: app?.categoryId || "app-tools",
        tags: app?.tags || [],
        status: normalized,
        favorite: Boolean(app?.favorite),
        overrides: state.data.appMeta[appId]?.overrides || {}
      };
    } else {
      const app = state.data.customApps.find((item) => item.id === appId);
      if (app) app.status = normalized;
    }
    saveData();
    renderAll();
  }

  function saveEventFromForm() {
    const payload = {
      id: makeId("event"),
      title: $("#eventTitle").value.trim(),
      date: $("#eventDate").value,
      startTime: $("#eventStart").value,
      endTime: $("#eventEnd").value,
      categoryId: $("#eventCategory").value,
      tags: normalizeTags($("#eventTags").value),
      notes: $("#eventNotes").value.trim(),
      source: "local",
      externalId: "",
      syncStatus: "local-only",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    if (!payload.title || !payload.date) return;
    state.data.events.push(payload);
    saveData();
    $("#eventForm").reset();
    $("#eventDate").value = todayIso();
    renderAll();
  }

  function setSection(section, options = {}) {
    state.section = section;
    if (options.resetFilters && state.filters[section === "board" ? "posts" : section]) {
      const key = section === "board" ? "posts" : section;
      state.filters[key].categoryId = "all";
      state.filters[key].tag = "";
      state.filters[key].status = key === "todos" ? "open" : "active";
    }
    $$(".section").forEach((node) => node.classList.toggle("active", node.id === `section-${section}`));
    $$(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.section === section));
    renderAll();
  }

  function exportData() {
    const payload = {
      exportedAt: new Date().toISOString(),
      serverBacked: state.serverBacked,
      portalData: portalDataForGit(state.data),
      localOnly: {
        googleEventCount: state.data.events.filter(isGoogleEvent).length
      }
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "local-desk-data.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function seedData() {
    if (!state.data.posts.length) {
      state.data.posts = [{
        id: "seed-kosis",
        title: "KOSIS 포털 전환",
        categoryId: "post-kosis",
        tags: ["KOSIS", "전환"],
        status: "active",
        body: "기존 Python GUI를 개인 홈의 첫 기능으로 연결.",
        createdAt: Date.now(),
        updatedAt: Date.now()
      }];
    }
    if (!state.data.todos.length) {
      state.data.todos = [{
        id: "seed-todo-portal",
        title: "Local Desk 포털 정리",
        notes: "달력, 할 일, 홈페이지 리스트를 개인 대시보드에 연결.",
        categoryId: "todo-work",
        tags: ["Local Desk"],
        status: "doing",
        priority: "normal",
        dueDate: todayIso(),
        order: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }];
    }
    if (!state.data.links.length) {
      state.data.links = [{
        id: "seed-link-google-calendar",
        name: "Google Calendar",
        url: "https://calendar.google.com/",
        description: "나중에 동기화 후보",
        categoryId: "link-reference",
        tags: ["달력", "동기화"],
        status: "active",
        favorite: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }];
    }
    saveData();
  }

  function bindEvents() {
    $$(".nav-item").forEach((button) => {
      button.addEventListener("click", () => setSection(button.dataset.section, { resetFilters: true }));
    });
    $$("[data-section-jump]").forEach((button) => {
      button.addEventListener("click", () => setSection(button.dataset.sectionJump, { resetFilters: true }));
    });

    $("#quickPostForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const title = $("#quickPostTitle").value.trim();
      const body = $("#quickPostBody").value.trim();
      if (!title || !body) return;
      state.data.posts.push({
        id: makeId("post"),
        title,
        body,
        categoryId: "post-memo",
        tags: [],
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      saveData();
      event.currentTarget.reset();
      renderAll();
    });

    $("#postForm").addEventListener("submit", (event) => {
      event.preventDefault();
      savePostFromForm();
    });
    $("#todoForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveTodoFromForm();
    });
    $("#linkForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveLinkFromForm();
    });
    $("#eventForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveEventFromForm();
    });

    $("#cancelPostEdit").addEventListener("click", resetPostForm);
    $("#cancelTodoEdit").addEventListener("click", resetTodoForm);
    $("#cancelSubTodo").addEventListener("click", resetTodoForm);
    $("#cancelLinkEdit").addEventListener("click", resetLinkForm);

    [
      ["postSearch", "posts", "keyword", renderPosts],
      ["appSearch", "apps", "keyword", renderApps],
      ["todoSearch", "todos", "keyword", renderTodos],
      ["linkSearch", "links", "keyword", renderLinks],
      ["postStatusFilter", "posts", "status", renderPosts],
      ["appStatusFilter", "apps", "status", renderApps],
      ["todoStatusFilter", "todos", "status", renderTodos],
      ["linkStatusFilter", "links", "status", renderLinks]
    ].forEach(([id, type, key, render]) => {
      $(`#${id}`).addEventListener("input", (event) => {
        state.filters[type][key] = event.target.value;
        render();
      });
      $(`#${id}`).addEventListener("change", (event) => {
        state.filters[type][key] = event.target.value;
        render();
      });
    });

    [
      ["postCategoryForm", "posts", "postCategoryName", "postCategoryParent"],
      ["appCategoryForm", "apps", "appCategoryName", "appCategoryParent"],
      ["todoCategoryForm", "todos", "todoCategoryName", "todoCategoryParent"],
      ["linkCategoryForm", "links", "linkCategoryName", "linkCategoryParent"]
    ].forEach(([formId, type, nameId, parentId]) => {
      $(`#${formId}`).addEventListener("submit", (event) => {
        event.preventDefault();
        addCategory(type, $(`#${nameId}`).value, $(`#${parentId}`).value);
        event.currentTarget.reset();
      });
    });

    $("#prevMonth").addEventListener("click", () => {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() - 1, 1);
      renderCalendar();
      maybeAutoSyncGoogleCalendar();
    });
    $("#nextMonth").addEventListener("click", () => {
      state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + 1, 1);
      renderCalendar();
      maybeAutoSyncGoogleCalendar();
    });
    $("#googleConnect").addEventListener("click", connectGoogleCalendar);
    $("#googleRefreshStatus").addEventListener("click", refreshGoogleCalendarStatus);
    $("#googleSyncMonth").addEventListener("click", syncGoogleCalendarMonth);
    $("#googleCalendarSelect").addEventListener("change", (event) => {
      state.data.calendarSettings.google.calendarId = event.target.value || "__all__";
      state.googleCalendar.syncedMonths.delete(googleSyncKey());
      saveData();
      renderGoogleCalendarStatus();
      maybeAutoSyncGoogleCalendar();
    });
    $("#gitRefresh").addEventListener("click", loadGitStatus);
    $("#gitPull").addEventListener("click", () => runGitAction("pull"));
    $("#gitPush").addEventListener("click", () => runGitAction("push"));
    $("#gitCommitForm").addEventListener("submit", (event) => {
      event.preventDefault();
      runGitAction("commit", { message: $("#gitCommitMessage").value.trim() });
    });

    document.addEventListener("click", (event) => {
      const categoryButton = event.target.closest("[data-category-filter]");
      if (categoryButton) {
        const type = categoryButton.dataset.categoryType;
        state.filters[type].categoryId = categoryButton.dataset.categoryFilter;
        state.filters[type].tag = "";
        ({ posts: renderPosts, apps: renderApps, todos: renderTodos, links: renderLinks }[type])();
        return;
      }

      const tagButton = event.target.closest("[data-tag-filter]");
      if (tagButton) {
        const type = tagButton.dataset.tagType;
        state.filters[type].tag = tagButton.dataset.tagFilter;
        ({ posts: renderPosts, apps: renderApps, todos: renderTodos, links: renderLinks }[type])();
        return;
      }

      if (event.target.dataset.editPost) return editPost(event.target.dataset.editPost);
      if (event.target.dataset.editTodo) return editTodo(event.target.dataset.editTodo);
      if (event.target.dataset.editLink) return editLink(event.target.dataset.editLink);
      if (event.target.dataset.editApp) return openAppDialog(event.target.dataset.editApp);
      if (event.target.dataset.addSubtodo) return startSubTodo(event.target.dataset.addSubtodo);

      if (event.target.dataset.postStatus) {
        const post = state.data.posts.find((item) => item.id === event.target.dataset.postStatus);
        if (post) {
          post.status = normalizeVisibility(event.target.dataset.status);
          post.updatedAt = Date.now();
          saveData();
          renderAll();
        }
        return;
      }
      if (event.target.dataset.appStatus) return updateAppStatus(event.target.dataset.appStatus, event.target.dataset.status);
      if (event.target.dataset.linkStatus) {
        const link = state.data.links.find((item) => item.id === event.target.dataset.linkStatus);
        if (link) {
          link.status = normalizeVisibility(event.target.dataset.status);
          link.updatedAt = Date.now();
          saveData();
          renderAll();
        }
        return;
      }
      if (event.target.dataset.todoStatus) {
        const todo = state.data.todos.find((item) => item.id === event.target.dataset.todoStatus);
        if (todo) {
          todo.status = normalizeTodoStatus(event.target.dataset.status);
          todo.updatedAt = Date.now();
          saveData();
          renderAll();
        }
        return;
      }

      if (event.target.dataset.deletePost) state.data.posts = state.data.posts.filter((item) => item.id !== event.target.dataset.deletePost);
      else if (event.target.dataset.deleteTodo) {
        const delId = event.target.dataset.deleteTodo;
        state.data.todos = state.data.todos.filter((item) => item.id !== delId && item.parentId !== delId);
      }
      else if (event.target.dataset.deleteLink) state.data.links = state.data.links.filter((item) => item.id !== event.target.dataset.deleteLink);
      else if (event.target.dataset.deleteEvent) state.data.events = state.data.events.filter((item) => item.id !== event.target.dataset.deleteEvent);
      else if (event.target.dataset.removeCustomApp) state.data.customApps = state.data.customApps.filter((item) => item.id !== event.target.dataset.removeCustomApp);
      else return;
      saveData();
      renderAll();
    });

    $("#openAddApp").addEventListener("click", () => openAppDialog());
    $("#openAddAppInline").addEventListener("click", () => openAppDialog());
    $("#closeAddApp").addEventListener("click", closeAppDialog);
    $("#cancelAppEdit").addEventListener("click", () => {
      resetAppForm();
      closeAppDialog();
    });
    $("#exportData").addEventListener("click", exportData);
    $("#addAppForm").addEventListener("submit", (event) => {
      event.preventDefault();
      saveAppFromForm();
    });
    $("#clearCustomApps").addEventListener("click", () => {
      if (!confirm("직접 추가한 기능 목록을 초기화할까요? 기본 기능은 그대로 둡니다.")) return;
      state.data.customApps = [];
      saveData();
      renderAll();
    });
  }

  async function init() {
    $("#todayText").textContent = todayLabel();
    $("#eventDate").value = todayIso();
    state.calendarMonth = new Date();
    await loadServerPortalData();
    seedData();
    bindEvents();
    renderAll();
    refreshGoogleCalendarStatus();
    loadGitStatus();
  }

  init();
})();

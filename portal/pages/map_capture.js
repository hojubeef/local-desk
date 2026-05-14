// Map Capture - Naver Static Map max-zoom mosaic capture.
// localStorage namespace: localDesk.mapCapture.settings
// CSS prefix: .mapcap-

(function () {
  "use strict";

  const STORAGE_KEY = "localDesk.mapCapture.settings";
  const CAPTURE_LOG_KEY = "localDesk.mapCapture.captureLog";
  const MAX_CAPTURE_LOGS = 30;
  const DEFAULT_CENTER = { lat: 37.566826, lng: 126.9786567 };
  const DEFAULT_ZOOM = 15;
  const NAVER_STATIC_MAX_LEVEL = 20;
  const NAVER_WORLD_TILE_SIZE = 512;
  const STATIC_CHUNK_SIZE = 1024;
  const WARN_STATIC_CALLS = 520;
  const WARN_CANVAS_SIDE = 30000;
  const WARN_CANVAS_PIXELS = 260_000_000;

  const state = {
    naverClientId: "",
    naverClientSecretSet: false,
    currentView: "ROADMAP",
    selection: null,
    selectionBounds: null,
    selecting: false,
    dragStart: null,
    naverReady: false,
    map: null,
    captureLogs: [],
    suppressSelectionClear: false,
    pendingRestoreBounds: null,
    mapChanging: false,
    mapSettledAt: 0,
    searchResults: [],
    searchMarkers: [],
    infoWindow: null,
    suppressSave: false,
  };

  const els = {};
  function $(id) { return document.getElementById(id); }

  function initEls() {
    els.status = $("mapcapStatus");
    els.usage = $("mapcapUsage");
    els.billingUsage = $("mapcapBillingUsage");
    els.searchInput = $("mapcapSearchInput");
    els.searchBtn = $("mapcapSearchBtn");
    els.clearMarkers = $("mapcapClearMarkers");
    els.searchResults = $("mapcapSearchResults");
    els.selectToggle = $("mapcapSelectToggle");
    els.clearSelection = $("mapcapClearSelection");
    els.areaInfo = $("mapcapAreaInfo");
    els.captureLog = $("mapcapCaptureLog");
    els.widthInput = $("mapcapWidth");
    els.heightInput = $("mapcapHeight");
    els.lockRatio = $("mapcapLockRatio");
    els.scale = $("mapcapScale");
    els.levelInput = $("mapcapLevel");
    els.qualityHelp = $("mapcapQualityHelp");
    els.exportBtn = $("mapcapExportBtn");
    els.hint = $("mapcapHint");
    els.progress = $("mapcapProgress");
    els.progressFill = $("mapcapProgressFill");
    els.progressText = $("mapcapProgressText");
    els.mapWrap = $("mapcapMapWrap");
    els.mapNaver = $("mapcapMapNaver");
    els.overlay = $("mapcapOverlay");
  }

  async function init() {
    initEls();
    bindUi();
    state.captureLogs = loadCaptureLogs();
    renderCaptureLog();
    setStatus("네이버 설정 확인 중...");
    try {
      const res = await fetch("/api/map-capture/config");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "설정을 가져오지 못했습니다.");
      state.naverClientId = data.naverClientId || "";
      state.naverClientSecretSet = !!data.naverClientSecretSet;
      await refreshUsage();
      await refreshBillingUsage();
      if (!state.naverClientId) {
        setStatus("NAVER_CLIENT_ID가 비어 있습니다. apps/map_capture/config.py를 확인해주세요.", "error");
        return;
      }
      await loadNaverSdk(state.naverClientId);
      initNaverMap();
      restoreSettings();
      resizeOverlayToMap();
      applyView(state.currentView);
      setStatus(state.naverClientSecretSet
        ? "네이버 지도 준비 완료. 영역 선택 후 PNG 저장을 누르세요."
        : "미리보기는 가능하지만, 최대줌 저장에는 NAVER_CLIENT_SECRET이 필요합니다.", state.naverClientSecretSet ? "" : "warn");
    } catch (error) {
      setStatus("초기화 실패: " + (error?.message || error), "error");
    }
  }

  function bindUi() {
    els.searchBtn.addEventListener("click", runSearch);
    els.clearMarkers.addEventListener("click", clearSearchResults);
    els.exportBtn.addEventListener("click", exportPng);
    els.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") runSearch();
    });
    els.selectToggle.addEventListener("click", toggleSelecting);
    els.clearSelection.addEventListener("click", () => clearSelection());
    els.overlay.addEventListener("pointerdown", onPointerDown);
    els.overlay.addEventListener("pointermove", onPointerMove);
    els.overlay.addEventListener("pointerup", onPointerUp);
    els.overlay.addEventListener("pointercancel", onPointerUp);
    document.querySelectorAll("input[name='mapcapView']").forEach((input) => {
      input.addEventListener("change", () => {
        state.currentView = input.value;
        applyView(state.currentView);
        saveCurrentMapState();
        updateAreaInfo();
      });
    });
    document.querySelectorAll("input[name='mapcapQuality']").forEach((input) => {
      input.addEventListener("change", () => {
        updateQualityHelp();
        updateAreaInfo();
        saveCurrentMapState();
      });
    });
    [els.widthInput, els.heightInput].forEach((input) => {
      input.addEventListener("change", () => {
        if (els.lockRatio.checked) syncOutputRatio(input === els.widthInput ? "width" : "height");
      });
    });
    els.lockRatio.addEventListener("change", () => {
      if (els.lockRatio.checked) syncOutputRatio("width");
    });
    [els.levelInput, els.scale].forEach((input) => {
      input.addEventListener("change", () => {
        updateQualityHelp();
        updateAreaInfo();
        saveCurrentMapState();
      });
    });
    window.addEventListener("resize", () => {
      resizeOverlayToMap();
      drawSelection();
    });
    updateQualityHelp();
  }

  function loadNaverSdk(key) {
    return new Promise((resolve, reject) => {
      if (window.naver && window.naver.maps) {
        state.naverReady = true;
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = "https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=" + encodeURIComponent(key) + "&submodules=geocoder";
      script.async = true;
      script.onload = () => {
        state.naverReady = true;
        resolve();
      };
      script.onerror = () => reject(new Error("네이버 지도 SDK를 불러오지 못했습니다."));
      document.head.appendChild(script);
    });
  }

  function initNaverMap() {
    const saved = loadSettings();
    const center = saved?.naver?.center || DEFAULT_CENTER;
    const zoom = Number(saved?.naver?.zoom || DEFAULT_ZOOM);
    state.map = new naver.maps.Map(els.mapNaver, {
      center: new naver.maps.LatLng(center.lat, center.lng),
      zoom,
      minZoom: 6,
      maxZoom: 21,
      mapTypeControl: false,
      scaleControl: true,
      logoControl: true,
    });
    state.infoWindow = new naver.maps.InfoWindow({
      maxWidth: 260,
      backgroundColor: "#111215",
      borderColor: "#38bdf8",
      borderWidth: 1,
      anchorSize: new naver.maps.Size(8, 8),
    });
    naver.maps.Event.addListener(state.map, "idle", () => {
      state.mapChanging = false;
      state.mapSettledAt = Date.now();
      saveCurrentMapState();
      if (state.pendingRestoreBounds) {
        applySelectionFromBounds(state.pendingRestoreBounds);
        state.pendingRestoreBounds = null;
        state.suppressSelectionClear = false;
      }
      updateAreaInfo();
    });
    ["bounds_changed", "center_changed"].forEach((name) => {
      naver.maps.Event.addListener(state.map, name, () => {
        state.mapChanging = true;
      });
    });
    naver.maps.Event.addListener(state.map, "dragend", () => {
      clearSelectionAfterMapChange("지도 위치가 바뀌어 선택 영역을 지웠습니다.");
      saveCurrentMapState();
    });
    naver.maps.Event.addListener(state.map, "zoom_changed", () => {
      state.mapChanging = true;
      clearSelectionAfterMapChange("지도 확대/축소가 바뀌어 선택 영역을 지웠습니다.");
      saveCurrentMapState();
    });
    naver.maps.Event.addListener(state.map, "mapTypeId_changed", () => {
      saveCurrentMapState();
      updateAreaInfo();
    });
  }

  function restoreSettings() {
    const saved = loadSettings();
    if (!saved) return;
    state.currentView = saved.view || "ROADMAP";
    const radio = document.querySelector(`input[name='mapcapView'][value='${state.currentView}']`);
    if (radio) radio.checked = true;
    if (saved.output) {
      els.widthInput.value = saved.output.width || els.widthInput.value;
      els.heightInput.value = saved.output.height || els.heightInput.value;
      els.scale.value = String(saved.output.scale || els.scale.value);
      els.levelInput.value = String(saved.output.level || els.levelInput.value);
      const quality = saved.output.quality || "custom";
      const qualityRadio = document.querySelector(`input[name='mapcapQuality'][value='${quality}']`);
      if (qualityRadio) qualityRadio.checked = true;
    }
    updateQualityHelp();
  }

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveCurrentMapState() {
    if (state.suppressSave || !state.map) return;
    const center = state.map.getCenter();
    const settings = {
      view: state.currentView,
      naver: {
        center: { lat: center.lat(), lng: center.lng() },
        zoom: state.map.getZoom(),
      },
      output: {
        width: clampInt(els.widthInput.value, 100, 16000, 1920),
        height: clampInt(els.heightInput.value, 100, 16000, 1080),
        scale: clampInt(els.scale.value, 1, 2, 2),
        level: clampInt(els.levelInput.value, 0, NAVER_STATIC_MAX_LEVEL, NAVER_STATIC_MAX_LEVEL),
        quality: selectedQuality(),
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function applyView(view) {
    if (!state.map || !window.naver?.maps?.MapTypeId) return;
    const ids = naver.maps.MapTypeId;
    const mapType = view === "SKYVIEW" ? ids.SATELLITE : (view === "HYBRID" ? ids.HYBRID : ids.NORMAL);
    state.map.setMapTypeId(mapType);
  }

  function staticMapType(view) {
    if (view === "SKYVIEW") return "satellite_base";
    if (view === "HYBRID") return "satellite";
    return "basic";
  }

  async function runSearch() {
    if (!state.map) return;
    const query = els.searchInput.value.trim();
    if (!query) return;
    setStatus("위치 검색 중...");
    renderSearchResults({ loading: true });
    try {
      const center = state.map.getCenter();
      const url = new URL("/api/map-capture/search", window.location.origin);
      url.searchParams.set("query", query);
      url.searchParams.set("centerLng", center.lng());
      url.searchParams.set("centerLat", center.lat());
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "검색에 실패했습니다.");
      state.searchResults = data.results || [];
      renderSearchResults(data);
      renderSearchMarkers(state.searchResults);
      updateSearchMarkerState();
      if (state.searchResults.length) {
        focusSearchResult(state.searchResults[0], { zoom: true, openInfo: true });
        const suffix = data.localSearchConfigured ? "" : " 장소명 검색 키가 없어서 주소 결과만 표시했습니다.";
        setStatus(`검색 결과 ${state.searchResults.length}건을 표시했습니다.${suffix}`, data.localSearchConfigured ? "" : "warn");
      } else {
        clearSearchMarkers();
        updateSearchMarkerState();
        setStatus(data.localSearchConfigured ? "검색 결과가 없습니다." : "검색 결과가 없습니다. 장소명 검색은 NAVER Local Search 키가 필요합니다.", "warn");
      }
    } catch (error) {
      renderSearchResults({ error: error?.message || String(error) });
      clearSearchMarkers();
      updateSearchMarkerState();
      setStatus("검색 실패: " + (error?.message || error), "error");
    }
  }

  function clearSearchResults() {
    state.searchResults = [];
    clearSearchMarkers();
    if (els.searchResults) {
      els.searchResults.hidden = true;
      els.searchResults.innerHTML = "";
    }
    updateSearchMarkerState();
    setStatus("검색 마커를 지웠습니다.");
  }

  function renderSearchResults(payload) {
    if (!els.searchResults) return;
    if (payload?.loading) {
      els.searchResults.hidden = false;
      els.searchResults.innerHTML = `<div class="mapcap-search-empty">검색 중...</div>`;
      return;
    }
    if (payload?.error) {
      els.searchResults.hidden = false;
      els.searchResults.innerHTML = `<div class="mapcap-search-empty">${escapeHtml(payload.error)}</div>`;
      return;
    }
    const results = payload?.results || state.searchResults || [];
    if (!results.length) {
      els.searchResults.hidden = false;
      const hint = payload?.localSearchConfigured === false
        ? "장소명 검색 키가 없어서 주소 검색만 가능합니다."
        : "검색 결과가 없습니다.";
      els.searchResults.innerHTML = `<div class="mapcap-search-empty">${hint}</div>`;
      return;
    }
    const warnings = (payload?.warnings || []).filter(Boolean);
    els.searchResults.hidden = false;
    els.searchResults.innerHTML = [
      warnings.length ? `<div class="mapcap-search-note">${escapeHtml(warnings[0])}</div>` : "",
      ...results.map((item, index) => `
        <button type="button" class="mapcap-search-result" data-index="${index}">
          <span class="mapcap-result-badge">${item.source === "place" ? "장소" : "주소"}</span>
          <span class="mapcap-result-main">
            <strong>${escapeHtml(item.title || "검색 결과")}</strong>
            <small>${escapeHtml(item.subtitle || item.category || "")}</small>
          </span>
        </button>
      `),
    ].join("");
    els.searchResults.querySelectorAll(".mapcap-search-result").forEach((button) => {
      button.addEventListener("click", () => {
        const item = results[Number(button.dataset.index)];
        focusSearchResult(item, { zoom: true, openInfo: true });
      });
    });
  }

  function renderSearchMarkers(results) {
    clearSearchMarkers();
    if (!state.map || !window.naver?.maps) return;
    results.forEach((item, index) => {
      const marker = new naver.maps.Marker({
        position: new naver.maps.LatLng(item.lat, item.lng),
        map: state.map,
        title: item.title || "검색 결과",
        icon: {
          content: `<div class="mapcap-marker"><span>${index + 1}</span></div>`,
          size: new naver.maps.Size(28, 28),
          anchor: new naver.maps.Point(14, 28),
        },
      });
      naver.maps.Event.addListener(marker, "click", () => {
        focusSearchResult(item, { zoom: false, openInfo: true });
      });
      state.searchMarkers.push(marker);
    });
  }

  function clearSearchMarkers() {
    state.searchMarkers.forEach((marker) => marker.setMap(null));
    state.searchMarkers = [];
    if (state.infoWindow) state.infoWindow.close();
  }

  function updateSearchMarkerState() {
    if (els.clearMarkers) {
      els.clearMarkers.disabled = !state.searchMarkers.length && !state.searchResults.length;
    }
  }

  function clearSelectionAfterMapChange(message) {
    if (!state.selection || state.dragStart || state.suppressSelectionClear) return;
    clearSelection(true);
    if (message) setStatus(message, "warn");
  }

  function focusSearchResult(item, options) {
    if (!item || !state.map) return;
    if (state.selection) {
      clearSelection(true);
      setStatus("검색 위치로 이동해서 기존 선택 영역을 지웠습니다.", "warn");
    }
    const position = new naver.maps.LatLng(item.lat, item.lng);
    state.map.panTo(position);
    if (options?.zoom) {
      state.map.setZoom(Math.max(state.map.getZoom(), 17));
    }
    if (options?.openInfo && state.infoWindow) {
      const marker = state.searchMarkers.find((candidate) => {
        const pos = candidate.getPosition();
        return Math.abs(pos.lat() - item.lat) < 0.000001 && Math.abs(pos.lng() - item.lng) < 0.000001;
      });
      state.infoWindow.setContent(`
        <div class="mapcap-info-window">
          <strong>${escapeHtml(item.title || "검색 결과")}</strong>
          <span>${escapeHtml(item.subtitle || item.category || "")}</span>
        </div>
      `);
      if (marker) state.infoWindow.open(state.map, marker);
    }
    saveCurrentMapState();
  }

  function toggleSelecting() {
    state.selecting = !state.selecting;
    els.overlay.classList.toggle("mapcap-overlay-active", state.selecting);
    els.selectToggle.textContent = state.selecting ? "선택 종료" : "영역 선택";
    els.hint.textContent = state.selecting ? "지도 위에서 드래그해 영역을 잡으세요." : "영역을 먼저 선택해주세요.";
  }

  function clearSelection(silent) {
    state.selection = null;
    state.selectionBounds = null;
    state.dragStart = null;
    drawSelection();
    updateExportState();
    updateAreaInfo();
    if (!silent) setStatus("선택 영역을 지웠습니다.");
  }

  function onPointerDown(event) {
    if (!state.selecting) return;
    const point = pointerPoint(event);
    state.dragStart = point;
    state.selection = { x: point.x, y: point.y, w: 0, h: 0 };
    state.selectionBounds = null;
    els.overlay.setPointerCapture(event.pointerId);
    drawSelection();
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!state.dragStart) return;
    const point = pointerPoint(event);
    state.selection = rectFromPoints(state.dragStart, point, event.shiftKey);
    state.selectionBounds = null;
    drawSelection();
    updateAreaInfo();
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (!state.dragStart) return;
    const point = pointerPoint(event);
    state.selection = rectFromPoints(state.dragStart, point, event.shiftKey);
    state.dragStart = null;
    if (state.selection.w < 8 || state.selection.h < 8) {
      state.selection = null;
      state.selectionBounds = null;
    } else {
      state.selectionBounds = selectionPixelsToBounds(state.selection);
      console.info("[MapCapture] selection bounds", JSON.parse(JSON.stringify(state.selectionBounds)));
    }
    drawSelection();
    updateExportState();
    updateAreaInfo();
    if (state.selection && els.lockRatio.checked) syncOutputRatio("width");
    event.preventDefault();
  }

  function pointerPoint(event) {
    const rect = els.mapWrap.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  }

  function rectFromPoints(start, end, square) {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    if (square) {
      const size = Math.min(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * size;
      dy = Math.sign(dy || 1) * size;
    }
    const x = Math.min(start.x, start.x + dx);
    const y = Math.min(start.y, start.y + dy);
    return {
      x,
      y,
      w: Math.abs(dx),
      h: Math.abs(dy),
    };
  }

  function resizeOverlayToMap() {
    const rect = els.mapWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    els.overlay.width = Math.max(1, Math.round(rect.width * dpr));
    els.overlay.height = Math.max(1, Math.round(rect.height * dpr));
    els.overlay.style.width = rect.width + "px";
    els.overlay.style.height = rect.height + "px";
    const ctx = els.overlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawSelection() {
    const rect = els.mapWrap.getBoundingClientRect();
    const ctx = els.overlay.getContext("2d");
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!state.selection) return;
    const { x, y, w, h } = state.selection;
    ctx.save();
    ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
    ctx.strokeStyle = "rgba(56, 189, 248, 0.95)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
    ctx.restore();
  }

  function selectionPixelsToBounds(selection) {
    if (!state.map || !selection) return null;
    const mapBounds = state.map.getBounds();
    const sw = mapBounds?.getSW?.();
    const ne = mapBounds?.getNE?.();
    if (!sw || !ne) return null;
    const rect = els.mapWrap.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const zoom = clampInt(state.map.getZoom(), 0, 21, DEFAULT_ZOOM);
    const { x, y, w, h } = selection;
    const worldNW = lngLatToWorldPixel(sw.lng(), ne.lat(), zoom);
    const worldSE = lngLatToWorldPixel(ne.lng(), sw.lat(), zoom);
    const worldW = worldSE.x - worldNW.x;
    const worldH = worldSE.y - worldNW.y;
    const x1 = worldNW.x + worldW * (x / width);
    const y1 = worldNW.y + worldH * (y / height);
    const x2 = worldNW.x + worldW * ((x + w) / width);
    const y2 = worldNW.y + worldH * ((y + h) / height);
    const nw = worldPixelToLngLat(Math.min(x1, x2), Math.min(y1, y2), zoom);
    const se = worldPixelToLngLat(Math.max(x1, x2), Math.max(y1, y2), zoom);
    const north = Math.max(nw.lat, se.lat);
    const south = Math.min(nw.lat, se.lat);
    const west = Math.min(nw.lng, se.lng);
    const east = Math.max(nw.lng, se.lng);
    return { north, south, west, east };
  }

  function selectionToBounds() {
    if (state.selectionBounds) return cloneBounds(state.selectionBounds);
    const bounds = selectionPixelsToBounds(state.selection);
    state.selectionBounds = bounds ? cloneBounds(bounds) : null;
    return bounds;
  }

  function cloneBounds(bounds) {
    if (!bounds) return null;
    return {
      north: Number(bounds.north),
      south: Number(bounds.south),
      west: Number(bounds.west),
      east: Number(bounds.east),
    };
  }

  function buildStaticPlan(bounds, level, scale) {
    const nw = lngLatToWorldPixel(bounds.west, bounds.north, level);
    const se = lngLatToWorldPixel(bounds.east, bounds.south, level);
    const minX = Math.min(nw.x, se.x);
    const maxX = Math.max(nw.x, se.x);
    const minY = Math.min(nw.y, se.y);
    const maxY = Math.max(nw.y, se.y);
    const widthCss = Math.max(1, maxX - minX);
    const heightCss = Math.max(1, maxY - minY);
    const cols = Math.max(1, Math.ceil(widthCss / STATIC_CHUNK_SIZE));
    const rows = Math.max(1, Math.ceil(heightCss / STATIC_CHUNK_SIZE));
    return {
      bounds,
      level,
      scale,
      minX,
      minY,
      widthCss,
      heightCss,
      canvasW: Math.ceil(widthCss * scale),
      canvasH: Math.ceil(heightCss * scale),
      cols,
      rows,
      calls: cols * rows,
    };
  }

  function warnLargePlan(plan) {
    const pixels = plan.canvasW * plan.canvasH;
    if (plan.calls > WARN_STATIC_CALLS || plan.canvasW > WARN_CANVAS_SIDE || plan.canvasH > WARN_CANVAS_SIDE || pixels > WARN_CANVAS_PIXELS) {
      console.warn("[MapCapture] large capture plan", {
        calls: plan.calls,
        width: plan.canvasW,
        height: plan.canvasH,
        pixels,
      });
    }
  }

  async function captureStaticMosaic(options, exportBounds) {
    const bounds = cloneBounds(exportBounds || selectionToBounds());
    if (!bounds) throw new Error("선택 영역이 없습니다.");
    const plan = buildStaticPlan(bounds, options.level, options.scale);
    warnLargePlan(plan);

    const canvas = document.createElement("canvas");
    canvas.width = plan.canvasW;
    canvas.height = plan.canvasH;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    const total = plan.calls;
    let done = 0;
    for (let row = 0; row < plan.rows; row += 1) {
      for (let col = 0; col < plan.cols; col += 1) {
        const chunkX = plan.minX + col * STATIC_CHUNK_SIZE;
        const chunkY = plan.minY + row * STATIC_CHUNK_SIZE;
        const chunkW = Math.min(STATIC_CHUNK_SIZE, plan.widthCss - col * STATIC_CHUNK_SIZE);
        const chunkH = Math.min(STATIC_CHUNK_SIZE, plan.heightCss - row * STATIC_CHUNK_SIZE);
        const center = worldPixelToLngLat(chunkX + chunkW / 2, chunkY + chunkH / 2, plan.level);
        const image = await fetchStaticImage({
          centerLng: center.lng,
          centerLat: center.lat,
          level: plan.level,
          w: Math.max(1, Math.ceil(chunkW)),
          h: Math.max(1, Math.ceil(chunkH)),
          scale: plan.scale,
          maptype: staticMapType(state.currentView),
        });
        ctx.drawImage(
          image,
          Math.round((chunkX - plan.minX) * plan.scale),
          Math.round((chunkY - plan.minY) * plan.scale),
          Math.ceil(chunkW * plan.scale),
          Math.ceil(chunkH * plan.scale),
        );
        if (image.close) image.close();
        done += 1;
        setProgress(done / total, `네이버 Static Map 조각 ${done}/${total} 합성 중...`);
      }
    }
    await refreshUsage();
    return { canvas, plan };
  }

  async function fetchStaticImage(params) {
    const url = new URL("/api/map-capture/naver-static", window.location.origin);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url);
    if (!response.ok) {
      let message = "네이버 Static Map 호출에 실패했습니다.";
      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        message = await response.text() || message;
      }
      throw new Error(message);
    }
    const blob = await response.blob();
    if ("createImageBitmap" in window) {
      return createImageBitmap(blob);
    }
    return blobToImage(blob);
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("이미지 조각을 읽지 못했습니다."));
      };
      image.src = url;
    });
  }

  async function exportPng() {
    if (!state.selection) {
      setStatus("영역을 먼저 선택해주세요.", "warn");
      return;
    }
    await waitForMapSettled();
    const quality = selectedQuality();
    const exportBounds = selectionToBounds();
    if (!exportBounds) {
      setStatus("선택 영역 좌표를 계산하지 못했습니다. 영역을 다시 선택해주세요.", "warn");
      return;
    }
    try {
      els.exportBtn.disabled = true;
      const exportMeta = exportMetadata(exportBounds, quality);
      console.info("[MapCapture] export start", exportMeta);
      setProgress(0.01, "캡처 준비 중...");
      let canvas;
      let plan = null;
      if (quality === "standard") {
        const level = clampInt(state.map?.getZoom?.(), 0, NAVER_STATIC_MAX_LEVEL, DEFAULT_ZOOM);
        const apiScale = Math.min(2, clampInt(els.scale.value, 1, 2, 1));
        const result = await captureStaticMosaic({ level, scale: apiScale }, exportBounds);
        plan = result.plan;
        canvas = resizeCanvas(
          result.canvas,
          clampInt(els.widthInput.value, 100, 16000, 1920),
          clampInt(els.heightInput.value, 100, 16000, 1080),
        );
      } else {
        const level = quality === "ultra"
          ? NAVER_STATIC_MAX_LEVEL
          : clampInt(els.levelInput.value, 0, NAVER_STATIC_MAX_LEVEL, NAVER_STATIC_MAX_LEVEL);
        const apiScale = quality === "ultra"
          ? 2
          : clampInt(els.scale.value, 1, 2, 2);
        const result = await captureStaticMosaic({
          level,
          scale: apiScale,
        }, exportBounds);
        canvas = result.canvas;
        plan = result.plan;
      }
      setProgress(0.98, "PNG 파일 만드는 중...");
      const filename = await downloadCanvas(canvas, quality);
      addCaptureLog({
        ...exportMeta,
        filename,
        output: { width: canvas.width, height: canvas.height },
        calls: plan?.calls || 0,
        nativeSize: plan ? { width: plan.canvasW, height: plan.canvasH } : { width: canvas.width, height: canvas.height },
      });
      setProgress(1, "완료");
      setStatus("PNG 저장을 완료했습니다.");
      setTimeout(() => setProgress(null), 700);
    } catch (error) {
      setStatus(error?.message || String(error), "error");
      setProgress(null);
    } finally {
      updateExportState();
    }
  }

  function resizeCanvas(source, width, height) {
    if (source.width === width && source.height === height) return source;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  function downloadCanvas(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("PNG 변환에 실패했습니다."));
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
        a.href = url;
        a.download = `map_naver_${state.currentView.toLowerCase()}_${quality}_${canvas.width}x${canvas.height}_${stamp}.png`;
        const filename = a.download;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        resolve(filename);
      }, "image/png");
    });
  }

  function exportMetadata(bounds, quality) {
    const center = state.map?.getCenter?.();
    return {
      id: String(Date.now()),
      createdAt: new Date().toISOString(),
      quality,
      view: state.currentView,
      bounds: cloneBounds(bounds),
      center: center ? { lat: center.lat(), lng: center.lng() } : null,
      zoom: state.map?.getZoom?.() || null,
    };
  }

  function waitForMapSettled() {
    if (!state.mapChanging && Date.now() - state.mapSettledAt > 150) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      const listener = naver.maps.Event.addListener(state.map, "idle", () => {
        naver.maps.Event.removeListener(listener);
        setTimeout(finish, 80);
      });
      setTimeout(() => {
        try {
          naver.maps.Event.removeListener(listener);
        } catch {
          // Ignore listener cleanup failures from older SDK builds.
        }
        finish();
      }, 900);
    });
  }

  function updateAreaInfo() {
    if (!state.selection) {
      els.areaInfo.hidden = true;
      els.areaInfo.textContent = "";
      delete els.areaInfo.dataset.level;
      return;
    }
    const bounds = selectionToBounds();
    if (!bounds) return;
    const mode = selectedQuality();
    const level = mode === "standard"
      ? clampInt(state.map?.getZoom?.(), 0, NAVER_STATIC_MAX_LEVEL, DEFAULT_ZOOM)
      : (mode === "ultra" ? NAVER_STATIC_MAX_LEVEL : clampInt(els.levelInput.value, 0, NAVER_STATIC_MAX_LEVEL, NAVER_STATIC_MAX_LEVEL));
    const scale = mode === "ultra" ? 2 : clampInt(els.scale.value, 1, 2, 2);
    const plan = buildStaticPlan(bounds, level, scale);
    const pixels = plan.canvasW * plan.canvasH;
    const veryLarge = plan.calls > WARN_STATIC_CALLS
      || plan.canvasW > WARN_CANVAS_SIDE
      || plan.canvasH > WARN_CANVAS_SIDE
      || pixels > WARN_CANVAS_PIXELS;
    const heavyUsage = plan.calls >= 80 || pixels >= 80_000_000;
    const status = veryLarge ? " / 매우 큼" : (heavyUsage ? " / 사용량 많음" : "");
    els.areaInfo.hidden = false;
    if (veryLarge || heavyUsage) els.areaInfo.dataset.level = "warn";
    else delete els.areaInfo.dataset.level;
    els.areaInfo.textContent = [
      `좌표: ${bounds.south.toFixed(6)},${bounds.west.toFixed(6)} ~ ${bounds.north.toFixed(6)},${bounds.east.toFixed(6)}`,
      `레벨 ${level}, ${scale}x 예상: ${plan.canvasW.toLocaleString()}×${plan.canvasH.toLocaleString()}px`,
      `예상 사용량: Static Map API ${plan.calls.toLocaleString()}건${status}`,
    ].join(" · ");
  }

  function loadCaptureLogs() {
    try {
      const logs = JSON.parse(localStorage.getItem(CAPTURE_LOG_KEY) || "[]");
      return Array.isArray(logs) ? logs.filter((log) => log?.bounds).slice(0, MAX_CAPTURE_LOGS) : [];
    } catch {
      return [];
    }
  }

  function saveCaptureLogs() {
    localStorage.setItem(CAPTURE_LOG_KEY, JSON.stringify(state.captureLogs.slice(0, MAX_CAPTURE_LOGS)));
  }

  function addCaptureLog(entry) {
    state.captureLogs = [entry, ...state.captureLogs].slice(0, MAX_CAPTURE_LOGS);
    saveCaptureLogs();
    renderCaptureLog();
    console.info("[MapCapture] capture log saved", entry);
  }

  function renderCaptureLog() {
    if (!els.captureLog) return;
    if (!state.captureLogs.length) {
      els.captureLog.hidden = true;
      els.captureLog.innerHTML = "";
      return;
    }
    els.captureLog.hidden = false;
    els.captureLog.innerHTML = state.captureLogs.map((log, index) => {
      const date = new Date(log.createdAt || Date.now());
      const label = Number.isNaN(date.getTime()) ? "시간 없음" : date.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const boundsText = formatBounds(log.bounds);
      const sizeText = log.output ? `${formatNumber(log.output.width)}×${formatNumber(log.output.height)}px` : "";
      return `
        <button type="button" class="mapcap-log-item" data-index="${index}">
          <strong>${escapeHtml(label)} · ${escapeHtml(log.view || "")} · ${escapeHtml(log.quality || "")}</strong>
          <span>${escapeHtml(sizeText)} · API ${formatNumber(log.calls || 0)}건</span>
          <small>${escapeHtml(boundsText)}</small>
        </button>
      `;
    }).join("");
    els.captureLog.querySelectorAll(".mapcap-log-item").forEach((button) => {
      button.addEventListener("click", () => {
        const log = state.captureLogs[Number(button.dataset.index)];
        restoreCaptureLog(log);
      });
    });
  }

  function restoreCaptureLog(log) {
    if (!log?.bounds || !state.map) return;
    const bounds = cloneBounds(log.bounds);
    state.suppressSelectionClear = true;
    state.pendingRestoreBounds = bounds;
    try {
      const naverBounds = new naver.maps.LatLngBounds(
        new naver.maps.LatLng(bounds.south, bounds.west),
        new naver.maps.LatLng(bounds.north, bounds.east),
      );
      state.map.fitBounds(naverBounds);
    } catch {
      state.map.setCenter(new naver.maps.LatLng(
        (bounds.north + bounds.south) / 2,
        (bounds.east + bounds.west) / 2,
      ));
      if (log.zoom) state.map.setZoom(log.zoom);
    }
    setTimeout(() => {
      if (state.pendingRestoreBounds) {
        applySelectionFromBounds(state.pendingRestoreBounds);
        state.pendingRestoreBounds = null;
        state.suppressSelectionClear = false;
      }
    }, 700);
    setStatus("캡처 로그 좌표를 불러왔습니다.");
  }

  function applySelectionFromBounds(bounds) {
    if (!bounds || !state.map) return false;
    const projection = state.map.getProjection();
    if (!projection?.fromCoordToOffset) return false;
    const nw = projection.fromCoordToOffset(new naver.maps.LatLng(bounds.north, bounds.west));
    const se = projection.fromCoordToOffset(new naver.maps.LatLng(bounds.south, bounds.east));
    const mapRect = els.mapWrap.getBoundingClientRect();
    const x = Math.max(0, Math.min(mapRect.width, Math.min(nw.x, se.x)));
    const y = Math.max(0, Math.min(mapRect.height, Math.min(nw.y, se.y)));
    const right = Math.max(0, Math.min(mapRect.width, Math.max(nw.x, se.x)));
    const bottom = Math.max(0, Math.min(mapRect.height, Math.max(nw.y, se.y)));
    state.selection = { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
    state.selectionBounds = cloneBounds(bounds);
    drawSelection();
    updateExportState();
    updateAreaInfo();
    return true;
  }

  function formatBounds(bounds) {
    if (!bounds) return "";
    return `${bounds.south.toFixed(6)},${bounds.west.toFixed(6)} ~ ${bounds.north.toFixed(6)},${bounds.east.toFixed(6)}`;
  }

  function updateExportState() {
    const ready = !!state.map && !!state.selection;
    els.exportBtn.disabled = !ready;
    els.clearSelection.disabled = !state.selection;
    els.hint.textContent = ready ? "PNG 저장을 누르면 선택 영역을 저장합니다." : "영역을 먼저 선택해주세요.";
  }

  function updateQualityHelp() {
    const quality = selectedQuality();
    const customControlsEnabled = quality === "custom";
    if (els.levelInput) els.levelInput.disabled = !customControlsEnabled;
    if (els.scale) els.scale.disabled = quality === "ultra";
    if (quality === "standard") {
      els.qualityHelp.textContent = "지금 보고 있는 지도 줌으로 저장하고, 아래 현재 지도 저장 크기에 맞춥니다.";
    } else if (quality === "custom") {
      els.qualityHelp.textContent = "입력한 줌 레벨과 픽셀 배율로 좌표 범위 원본을 저장합니다. 레벨 20이 최대 확대입니다.";
    } else {
      els.qualityHelp.textContent = "레벨 20, 2x로 고정 저장합니다. 가장 선명하지만 영역이 넓으면 API 사용량이 빠르게 늘어납니다.";
    }
  }

  async function refreshUsage() {
    try {
      const response = await fetch("/api/map-capture/usage");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "사용량 조회 실패");
      els.usage.textContent = `앱 계산 사용량(${data.month}): ${formatNumber(data.used)} / ${formatNumber(data.limit)}건, 남은 ${formatNumber(data.remaining)}건`;
    } catch (error) {
      els.usage.textContent = "앱 계산 사용량: 조회 실패 - " + (error?.message || error);
    }
  }

  async function refreshBillingUsage() {
    try {
      const response = await fetch("/api/map-capture/naver-billing-usage");
      const data = await response.json();
      if (!data.configured) {
        els.billingUsage.textContent = "네이버 산정 사용량: Billing 키 미설정";
        return;
      }
      if (!response.ok || !data.ok) {
        els.billingUsage.textContent = "네이버 산정 사용량: 조회 실패 - " + (data.message || response.statusText);
        return;
      }
      if (!data.matchedRows) {
        els.billingUsage.textContent = `네이버 산정 사용량(${data.month}): Maps 항목을 찾지 못했습니다. 전체 ${formatNumber(data.totalRows)}행`;
        return;
      }
      els.billingUsage.textContent = `네이버 산정 사용량(${data.month}): 매칭 ${formatNumber(data.matchedRows)}행, 수량 합계 ${formatNumber(data.totalUserUsageQuantity)}`;
    } catch (error) {
      els.billingUsage.textContent = "네이버 산정 사용량: 조회 실패 - " + (error?.message || error);
    }
  }

  function selectedQuality() {
    return document.querySelector("input[name='mapcapQuality']:checked")?.value || "custom";
  }

  function syncOutputRatio(base) {
    if (!state.selection) return;
    const ratio = state.selection.w / Math.max(1, state.selection.h);
    if (base === "height") {
      const height = clampInt(els.heightInput.value, 100, 16000, 1080);
      els.widthInput.value = Math.round(height * ratio);
    } else {
      const width = clampInt(els.widthInput.value, 100, 16000, 1920);
      els.heightInput.value = Math.round(width / ratio);
    }
    saveCurrentMapState();
  }

  function lngLatToWorldPixel(lng, lat, level) {
    const sinLat = Math.sin(clampNumber(lat, -85.05112878, 85.05112878, 0) * Math.PI / 180);
    const world = NAVER_WORLD_TILE_SIZE * Math.pow(2, level);
    return {
      x: (lng + 180) / 360 * world,
      y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * world,
    };
  }

  function worldPixelToLngLat(x, y, level) {
    const world = NAVER_WORLD_TILE_SIZE * Math.pow(2, level);
    const lng = x / world * 360 - 180;
    const n = Math.PI - 2 * Math.PI * y / world;
    const lat = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lng, lat };
  }

  function setStatus(message, level) {
    els.status.textContent = message;
    if (level) els.status.dataset.level = level;
    else delete els.status.dataset.level;
  }

  function setProgress(value, text) {
    if (value == null) {
      els.progress.hidden = true;
      els.progressFill.style.width = "0%";
      els.progressText.textContent = "";
      return;
    }
    els.progress.hidden = false;
    els.progressFill.style.width = Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
    els.progressText.textContent = text || "";
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function clampInt(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();

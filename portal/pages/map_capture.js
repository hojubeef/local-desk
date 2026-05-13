// Map Capture - 카카오맵 영역 캡처 도구
// localStorage 네임스페이스: localDesk.mapCapture.*
// 스타일 접두사: .mapcap-

(function () {
  "use strict";

  const STORAGE_KEY = "localDesk.mapCapture.settings";
  const DEFAULT_CENTER = { lat: 37.566826, lng: 126.9786567 }; // 서울시청
  const DEFAULT_LEVEL = 5;

  const state = {
    kakaoKey: "",
    map: null,
    selection: null, // {x, y, w, h} in CSS pixels relative to map container
    selecting: false,
    dragStart: null,
    currentView: "ROADMAP",
  };

  const els = {
    status: document.getElementById("mapcapStatus"),
    searchInput: document.getElementById("mapcapSearchInput"),
    searchBtn: document.getElementById("mapcapSearchBtn"),
    selectToggle: document.getElementById("mapcapSelectToggle"),
    clearSelection: document.getElementById("mapcapClearSelection"),
    widthInput: document.getElementById("mapcapWidth"),
    heightInput: document.getElementById("mapcapHeight"),
    lockRatio: document.getElementById("mapcapLockRatio"),
    scale: document.getElementById("mapcapScale"),
    exportBtn: document.getElementById("mapcapExportBtn"),
    hint: document.getElementById("mapcapHint"),
    mapWrap: document.getElementById("mapcapMapWrap"),
    map: document.getElementById("mapcapMap"),
    overlay: document.getElementById("mapcapOverlay"),
  };

  // ---------- 초기화 ----------

  async function init() {
    loadSettings();
    setStatus("API 키 가져오는 중...");
    try {
      const res = await fetch("/api/map-capture/config");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "설정을 가져오지 못했습니다.");
      if (!data.kakaoJsKey) {
        setStatus(
          "카카오 JavaScript 키가 설정되지 않았습니다. apps/map_capture/config.py 를 확인해주세요.",
          "error"
        );
        return;
      }
      state.kakaoKey = data.kakaoJsKey;
      await loadKakaoSdk(state.kakaoKey);
      initMap();
      bindUi();
      setStatus("지도가 준비되었습니다. 영역을 선택해 캡처하세요.");
    } catch (error) {
      setStatus("초기화 실패: " + (error?.message || error), "error");
    }
  }

  function loadKakaoSdk(key) {
    return new Promise((resolve, reject) => {
      if (window.kakao && window.kakao.maps) {
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src =
        "https://dapi.kakao.com/v2/maps/sdk.js?appkey=" +
        encodeURIComponent(key) +
        "&autoload=false&libraries=services";
      script.onload = () => {
        if (!window.kakao || !window.kakao.maps) {
          reject(new Error("카카오 SDK 로드 실패"));
          return;
        }
        window.kakao.maps.load(() => resolve());
      };
      script.onerror = () =>
        reject(
          new Error(
            "카카오 SDK 스크립트를 불러오지 못했습니다. 키 또는 플랫폼 등록(http://127.0.0.1:8765)을 확인하세요."
          )
        );
      document.head.appendChild(script);
    });
  }

  function initMap() {
    const saved = readSettings();
    const center = new kakao.maps.LatLng(
      saved.center?.lat ?? DEFAULT_CENTER.lat,
      saved.center?.lng ?? DEFAULT_CENTER.lng
    );
    state.map = new kakao.maps.Map(els.map, {
      center,
      level: saved.level ?? DEFAULT_LEVEL,
    });
    applyView(saved.view || "ROADMAP");
    kakao.maps.event.addListener(state.map, "idle", saveCurrentMapState);
    resizeOverlayToMap();
    window.addEventListener("resize", resizeOverlayToMap);
  }

  function applyView(viewKey) {
    state.currentView = viewKey;
    const map = state.map;
    if (!map) return;
    // 카카오: ROADMAP(일반), SKYVIEW(위성), HYBRID(위성+라벨)
    if (viewKey === "ROADMAP") {
      map.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
      removeOverlayType("HYBRID");
    } else if (viewKey === "SKYVIEW") {
      map.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
      removeOverlayType("HYBRID");
    } else if (viewKey === "HYBRID") {
      map.setMapTypeId(kakao.maps.MapTypeId.SKYVIEW);
      map.addOverlayMapTypeId(kakao.maps.MapTypeId.HYBRID);
    }
    saveCurrentMapState();
  }

  function removeOverlayType(typeKey) {
    try {
      state.map.removeOverlayMapTypeId(kakao.maps.MapTypeId[typeKey]);
    } catch (_) {
      // 안 깔려있어도 무시
    }
  }

  // ---------- 영역 선택 (캔버스 오버레이) ----------

  function bindUi() {
    document.querySelectorAll('input[name="mapcapView"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        if (e.target.checked) applyView(e.target.value);
      });
      if (radio.value === state.currentView) radio.checked = true;
    });

    els.searchBtn.addEventListener("click", runSearch);
    els.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch();
      }
    });

    els.selectToggle.addEventListener("click", toggleSelectMode);
    els.clearSelection.addEventListener("click", clearSelection);

    els.overlay.addEventListener("mousedown", onOverlayMouseDown);
    els.overlay.addEventListener("mousemove", onOverlayMouseMove);
    window.addEventListener("mouseup", onOverlayMouseUp);

    els.widthInput.addEventListener("change", () => persistOutputSettings());
    els.heightInput.addEventListener("change", () => persistOutputSettings());
    els.lockRatio.addEventListener("change", () => persistOutputSettings());
    els.scale.addEventListener("change", () => persistOutputSettings());

    els.exportBtn.addEventListener("click", exportPng);

    // 저장된 출력 설정 복원
    const saved = readSettings();
    if (saved.width) els.widthInput.value = saved.width;
    if (saved.height) els.heightInput.value = saved.height;
    if (saved.lockRatio) els.lockRatio.checked = true;
    if (saved.scale) els.scale.value = String(saved.scale);
  }

  function toggleSelectMode() {
    state.selecting = !state.selecting;
    els.selectToggle.textContent = state.selecting ? "영역 선택 끄기" : "영역 선택 시작";
    els.overlay.classList.toggle("mapcap-overlay-active", state.selecting);
    setStatus(
      state.selecting
        ? "드래그해서 영역을 지정하세요. Shift = 정사각형 고정."
        : "지도 위치를 이동하려면 영역 선택을 끄세요."
    );
  }

  function clearSelection() {
    state.selection = null;
    state.dragStart = null;
    drawOverlay();
    els.clearSelection.disabled = true;
    els.exportBtn.disabled = true;
    els.hint.textContent = "영역을 먼저 선택해주세요.";
  }

  function resizeOverlayToMap() {
    const rect = els.map.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    els.overlay.width = Math.round(rect.width * dpr);
    els.overlay.height = Math.round(rect.height * dpr);
    els.overlay.style.width = rect.width + "px";
    els.overlay.style.height = rect.height + "px";
    const ctx = els.overlay.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlay();
  }

  function getOverlayPoint(event) {
    const rect = els.overlay.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function onOverlayMouseDown(e) {
    if (!state.selecting) return;
    e.preventDefault();
    const p = getOverlayPoint(e);
    state.dragStart = p;
    state.selection = { x: p.x, y: p.y, w: 0, h: 0 };
    drawOverlay();
  }

  function onOverlayMouseMove(e) {
    if (!state.selecting || !state.dragStart) return;
    const p = getOverlayPoint(e);
    let x = Math.min(state.dragStart.x, p.x);
    let y = Math.min(state.dragStart.y, p.y);
    let w = Math.abs(p.x - state.dragStart.x);
    let h = Math.abs(p.y - state.dragStart.y);
    if (e.shiftKey) {
      const side = Math.min(w, h);
      w = side;
      h = side;
      // Shift일 때는 드래그 시작점 기준으로 정사각형
      if (p.x < state.dragStart.x) x = state.dragStart.x - side;
      else x = state.dragStart.x;
      if (p.y < state.dragStart.y) y = state.dragStart.y - side;
      else y = state.dragStart.y;
    }
    state.selection = { x, y, w, h };
    drawOverlay();
  }

  function onOverlayMouseUp() {
    if (!state.selecting || !state.dragStart) return;
    state.dragStart = null;
    if (!state.selection || state.selection.w < 4 || state.selection.h < 4) {
      state.selection = null;
      drawOverlay();
      return;
    }
    els.clearSelection.disabled = false;
    els.exportBtn.disabled = false;
    els.hint.textContent =
      "선택 영역: " +
      Math.round(state.selection.w) +
      " × " +
      Math.round(state.selection.h) +
      " px (화면 기준)";

    if (els.lockRatio.checked) {
      const ratio = state.selection.w / state.selection.h;
      const baseHeight = Number(els.heightInput.value) || 1080;
      els.widthInput.value = Math.round(baseHeight * ratio);
      persistOutputSettings();
    }
  }

  function drawOverlay() {
    const ctx = els.overlay.getContext("2d");
    const w = parseFloat(els.overlay.style.width) || els.overlay.width;
    const h = parseFloat(els.overlay.style.height) || els.overlay.height;
    ctx.clearRect(0, 0, w, h);
    if (!state.selection) return;
    const s = state.selection;
    // 바깥 어둡게
    ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(s.x, s.y, s.w, s.h);
    // 테두리
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;
    ctx.strokeRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
  }

  // ---------- 검색 ----------

  function runSearch() {
    const query = els.searchInput.value.trim();
    if (!query) return;
    if (!window.kakao?.maps?.services) {
      setStatus("검색 서비스 라이브러리가 로드되지 않았습니다.", "error");
      return;
    }
    const places = new kakao.maps.services.Places();
    places.keywordSearch(query, (data, status) => {
      if (status !== kakao.maps.services.Status.OK || !data.length) {
        // 주소 검색으로 폴백
        const geocoder = new kakao.maps.services.Geocoder();
        geocoder.addressSearch(query, (res, st) => {
          if (st === kakao.maps.services.Status.OK && res.length) {
            moveTo(res[0].y, res[0].x);
            setStatus(`주소 이동: ${res[0].address_name}`);
          } else {
            setStatus("검색 결과가 없습니다.", "warn");
          }
        });
        return;
      }
      moveTo(data[0].y, data[0].x);
      setStatus(`이동: ${data[0].place_name}`);
    });
  }

  function moveTo(lat, lng) {
    const pos = new kakao.maps.LatLng(Number(lat), Number(lng));
    state.map.setCenter(pos);
    saveCurrentMapState();
  }

  // ---------- PNG 출력 ----------

  async function exportPng() {
    if (!state.selection) return;
    const targetW = clampInt(els.widthInput.value, 100, 8000, 1920);
    const targetH = clampInt(els.heightInput.value, 100, 8000, 1080);
    const scaleMul = Number(els.scale.value) || 2;

    els.exportBtn.disabled = true;
    setStatus("캡처 중... 잠시만 기다려주세요.");

    try {
      // 1) 지도 영역 전체를 html2canvas로 캡처
      const fullCanvas = await html2canvas(els.map, {
        useCORS: true,
        allowTaint: false,
        scale: scaleMul,
        backgroundColor: null,
        logging: false,
      });

      // 2) 선택 영역만 잘라내기
      const sel = state.selection;
      const mapRect = els.map.getBoundingClientRect();
      const sx = (sel.x / mapRect.width) * fullCanvas.width;
      const sy = (sel.y / mapRect.height) * fullCanvas.height;
      const sw = (sel.w / mapRect.width) * fullCanvas.width;
      const sh = (sel.h / mapRect.height) * fullCanvas.height;

      // 3) 사용자가 지정한 해상도로 리사이즈
      const outCanvas = document.createElement("canvas");
      outCanvas.width = targetW;
      outCanvas.height = targetH;
      const ctx = outCanvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, targetW, targetH);

      // 4) 다운로드
      const blob = await new Promise((res) => outCanvas.toBlob(res, "image/png"));
      const filename = makeFileName(targetW, targetH);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setStatus(`저장 완료: ${filename} (${targetW}×${targetH})`);
    } catch (error) {
      setStatus("캡처 실패: " + (error?.message || error), "error");
    } finally {
      els.exportBtn.disabled = false;
    }
  }

  function makeFileName(w, h) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp =
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "_" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds());
    const view = state.currentView.toLowerCase();
    return `map_${view}_${w}x${h}_${stamp}.png`;
  }

  // ---------- 유틸 ----------

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function setStatus(message, level) {
    els.status.textContent = message;
    els.status.dataset.level = level || "info";
  }

  // ---------- 설정 저장 ----------

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (_) {
      return {};
    }
  }

  function saveSettings(updates) {
    const current = readSettings();
    const next = { ...current, ...updates };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  function loadSettings() {
    // bindUi에서 UI 값 복원하므로 여기선 비워둠
  }

  function saveCurrentMapState() {
    if (!state.map) return;
    const c = state.map.getCenter();
    saveSettings({
      center: { lat: c.getLat(), lng: c.getLng() },
      level: state.map.getLevel(),
      view: state.currentView,
    });
  }

  function persistOutputSettings() {
    saveSettings({
      width: Number(els.widthInput.value) || 1920,
      height: Number(els.heightInput.value) || 1080,
      lockRatio: !!els.lockRatio.checked,
      scale: Number(els.scale.value) || 2,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

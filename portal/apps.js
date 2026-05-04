window.portalApps = [
  {
    id: "kosis",
    name: "KOSIS 통계",
    type: "page",
    path: "./pages/kosis.html",
    description: "웹 화면에서 지역 통계표 검색",
    initials: "KS",
    categoryId: "app-stats",
    tags: ["KOSIS", "통계"],
    status: "active",
    favorite: true
  },
  {
    id: "kosis-gui",
    name: "KOSIS GUI",
    type: "local",
    path: "../scripts/KOSIS 실행.vbs",
    description: "기존 Tkinter 프로그램 실행",
    initials: "KG",
    categoryId: "app-stats",
    tags: ["KOSIS", "GUI"],
    status: "archived",
    favorite: false
  },
  {
    id: "kosis-debug",
    name: "KOSIS 오류확인",
    type: "local",
    path: "../scripts/KOSIS 실행_오류확인.bat",
    description: "콘솔 창으로 실행 상태 확인",
    initials: "KD",
    categoryId: "app-tools",
    tags: ["KOSIS", "점검"],
    status: "archived",
    favorite: false
  },
  {
    id: "readme",
    name: "프로젝트 노트",
    type: "file",
    path: "../apps/kosis/README.md",
    description: "현재 KOSIS 도구 설명 파일",
    initials: "RM",
    categoryId: "app-docs",
    tags: ["문서", "설명"],
    status: "active",
    favorite: false
  }
];

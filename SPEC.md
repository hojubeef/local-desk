# Local Desk — 프로젝트 스펙

이 문서는 AI(Claude 등)가 이 프로젝트에서 작업할 때 **반드시 먼저 읽어야 할** 규칙과 맥락입니다.
사람이 읽어도 되지만, 주된 목적은 AI에게 프로젝트를 정확히 이해시키는 것입니다.

---

## 1. AI 작업 원칙

이 프로젝트에서 AI가 작업할 때 반드시 지켜야 할 태도:

**정직하게 작업한다.**
- 모르거나 애매한 것은 추측하지 말고 "모르겠다", "확인이 필요하다"고 말한다.
- 확실하지 않은 코드를 넣지 않는다. 동작이 보장되지 않으면 그 사실을 밝힌다.
- 기존 코드를 충분히 읽고 이해한 뒤에 수정한다. 구조를 파악하지 않은 채 건드리지 않는다.

**더 나은 방법을 제시한다.**
- 사용자가 제시한 방법보다 더 효율적이거나 깔끔한 방법이 있으면 적극적으로 제안한다.
- 확신이 없으면 "이런 방법도 있다" 정도로 추천만 하고, 사용자가 선택하게 한다.
- 사용자의 요청이 기존 구조를 깨뜨릴 수 있으면 반드시 먼저 경고한다.

**코어를 보호한다.**
- 새 기능은 모듈(apps/)로 분리하는 것을 항상 우선으로 고려한다.
- 코어 파일 수정이 필요하면 최소한의 변경만 하고, 변경 이유를 설명한다.
- 코어에 특정 모듈 전용 코드를 넣지 않는다.

**작업 전 확인한다.**
- 새 기능을 만들기 전에 이미 구현되어 있는지 먼저 확인한다.
- 이 SPEC.md, README.md, 그리고 관련 코드를 읽은 뒤에 작업을 시작한다.
- `overtime_journal_app/`은 별도 단독 앱이므로, 사용자가 야근일지 작업을 명시하지 않았다면 읽거나 수정하지 않는다.

---

## 2. 프로젝트 개요

- 개인용 로컬 포털. 브라우저에서 `127.0.0.1:8765`로 접속하는 홈페이지.
- 집과 회사 PC를 Git(GitHub)으로 동기화.
- KOSIS 통계 조회, 달력, 앱 관리 등 업무/개인 도구를 한곳에 모음.
- 회사에서 만든 기능들을 정리하고, 새로운 도구를 계속 추가해나가는 것이 목표.

---

## 3. 아키텍처 원칙

**코어를 유연하게 유지하면서, 다양한 모듈(앱)을 붙이는 방식으로 개발한다.**

### 코어 (`portal/`)

홈페이지 UI, 탭 라우팅, 공통 스타일, Git 관리 화면 등 기반 기능.

- `portal/index.html` — 메인 HTML (홈, 메모, 할일, 달력, 링크, 기능, Git 탭)
- `portal/app.js` — 코어 로직 (탭 전환, CRUD, Git 연동, 달력, 데이터 저장)
- `portal/styles.css` — 전체 스타일
- `portal/apps.js` — 앱 목록 등록 (여기에 새 앱을 추가하면 포털에 표시됨)
- `portal/data/portal-data.json` — 동기화되는 포털 데이터 (일정, 메모, 할일 등)

코어는 **가볍고 범용적**으로 유지할 것. 특정 기능의 로직을 코어에 직접 넣지 않는다.

### 앱 모듈 (`apps/`)

각 기능은 독립된 모듈로, `apps/기능명/` 폴더에 넣는다.

- 각 앱은 코어에 최소한으로 의존해야 한다.
- 현재 앱: `apps/kosis/` (KOSIS 통계 조회 도구)
- 포털과의 연결은 `portal/apps.js`에 항목을 추가하는 방식.
- 웹 화면이 필요한 앱은 `portal/pages/`에 HTML/JS를 둔다.

### 기타 폴더

- `scripts/` — 실행 스크립트 (배치 파일, VBS 등)
- `local/` — Git에 올리지 않는 PC별 개인 파일, 비밀 키, 캐시 등
- `overtime_journal_app/` — 야근일지 Windows 단독 앱. Local Desk/KOSIS 작업 범위와 분리한다.

### 별도 관리 앱 (`overtime_journal_app/`)

야근일지는 같은 저장소에 둘 수 있지만 이 SPEC의 Local Desk/KOSIS 규칙을 그대로 적용하는 포털 모듈이 아니다.

- 야근일지 관련 요청일 때만 `overtime_journal_app/README.md`와 `overtime_journal_app/SPEC.md`를 읽고 작업한다.
- KOSIS, 보고서 기초자료, 포털 코어 작업에서는 `overtime_journal_app/`을 기본 탐색 범위에서 제외한다.
- Local Desk에서 야근일지를 실행해야 할 경우에도, 원칙적으로는 단독 EXE를 실행하는 런처 방식으로 연결하고 야근일지 내부 코드는 분리 유지한다.
- 왼쪽 사이드바의 `야근일지` 메뉴는 단독 EXE 런처 화면이며, 야근일지 본체 로직은 `overtime_journal_app/` 안에서만 관리한다.
- Local Desk 자체 실행 옵션은 왼쪽 사이드바의 별도 `설정` 메뉴에서 관리한다. 개별 앱 화면에 공통 설정을 섞지 않는다.
- 야근일지의 빌드 결과물(`dist/`, `build/`, `*.spec`)은 Git에 올리지 않는다.

### 현재 구조의 알려진 제약

현재 코어에 일부 KOSIS 전용 스타일(`styles.css`의 `.kosis-layout` 등)이 섞여 있다.
이상적으로는 모듈별 스타일도 분리해야 하지만, 현재는 빌드 도구 없이 단일 CSS를 쓰고 있어서
이 정도는 허용한다. 다만 새 모듈을 추가할 때는 클래스명에 모듈 접두사를 붙여서
충돌을 방지할 것 (예: `.kosis-`, `.newmodule-`).

---

## 4. 코딩 규칙

- **빌드 도구 없음.** webpack, vite 등 사용하지 않는다. HTML/JS/CSS 직접 작성.
- **단일 파일 선호.** 하나의 기능이 여러 파일로 흩어지지 않게 한다.
- **한글 사용 가능.** 파일명, 변수명 외의 UI 텍스트와 주석은 한글로 작성해도 됨.
- **코어 수정은 신중하게.** `portal/index.html`, `portal/app.js`, `portal/styles.css`는 모든 기능의 기반이므로 기존 구조를 깨뜨리지 않도록 주의.
- 새 기능은 `apps/` 아래에 모듈로 추가하는 것을 우선으로 한다.
- 포털에 앱을 등록하는 방법은 `portal/apps.js`의 기존 항목을 참고.
- **모듈별 스타일 클래스에는 접두사를 붙인다.** (예: `.kosis-layout`, `.kosis-search-panel`)
- **localStorage 키는 모듈별 네임스페이스를 사용한다.** (예: `localDesk.kosis.`, `localDesk.newmodule.`)

---

## 5. 새 앱 모듈 추가 절차

1. `apps/새기능/` 폴더 생성
2. 필요한 코드 작성 (Python 백엔드, HTML 프론트 등)
3. 웹 화면이 필요하면 `portal/pages/새기능.html`, `portal/pages/새기능.js` 생성
4. `portal/apps.js`에 앱 항목 추가 (**이 파일 하나만 수정하면 앱 등록 완료**):
   ```js
   {
     id: "새기능",
     name: "표시 이름",
     type: "page",          // "page" = 포털 내 웹화면, "local" = 로컬 프로그램 실행
     path: "./pages/새기능.html",
     description: "설명",
     initials: "XX",
     categoryId: "app-tools",   // 기능 탭의 분류 (app-stats, app-tools, app-docs 등)
     tags: ["태그1", "태그2"],
     status: "active",          // "active" = 표시, "archived" = 보관, "hidden" = 숨김
     favorite: true             // 홈 화면에 표시 여부
   }
   ```
   `app.js`의 `defaultAppMeta`는 `apps.js`에서 자동 생성되므로 별도 수정 불필요.
5. 스타일이 필요하면 `portal/styles.css` 하단에 모듈 접두사 붙여서 추가
6. API 키가 필요하면 `config.example.py` 패턴 사용 (아래 보안사항 참고)
7. README.md 폴더 구조에 새 앱 추가
8. 백엔드 API가 필요하면 `apps/새기능/` 안에 서버 로직을 두고, `web_server.py`에 라우트 추가

---

## 6. 보안사항 — 반드시 지킬 것

- **API 키, 인증 파일은 절대 Git에 올리지 않는다.**
- 코드에 API 키나 토큰을 하드코딩하지 않는다. 항상 별도 설정 파일에서 불러온다.
- `config.py`, `.env`, `local/secrets/*`는 `.gitignore`로 제외되어 있음.
- 새 기능에 API 키가 필요하면 `config.example.py` 패턴을 따른다:
  - `config.example.py` (키 없는 템플릿) → Git에 올림
  - `config.py` (실제 키) → `.gitignore`에 추가, Git에 올리지 않음
- `portal/data/portal-data.json`에는 직접 만든 로컬 일정만 저장.
  외부 API(Google Calendar 등)에서 가져온 데이터는 이 파일에 저장하지 않는다.
- 개인정보나 민감한 데이터가 포함된 결과물(엑셀, CSV 등)은 Git에 올리지 않는다.

---

## 7. Git 동기화 규칙

Git에 올리는 것:
`portal/`, `apps/`, `scripts/`의 코드, `portal/data/portal-data.json`, `README.md`, `SPEC.md`, `.gitignore`, `overtime_journal_app/`의 소스와 문서

Git에 올리지 않는 것:
`config.py`, `.env`, `local/` 안의 실제 파일, 엑셀/CSV/ZIP 결과물, `.venv/`, `__pycache__/`, `overtime_journal_app/build/`, `overtime_journal_app/dist/`, `overtime_journal_app/*.spec`

자세한 제외 규칙은 `.gitignore` 파일 참고.

---

## 8. 새 PC 세팅 체크리스트

clone 후 아래 항목을 수동으로 설정해야 함:

- [ ] `apps/kosis/config.example.py` → `config.py`로 복사, API 키 입력
- [ ] `local/secrets/google-calendar-credentials.json` — Google OAuth JSON 저장
- [ ] Local Desk 달력 화면에서 Google Calendar '연결' → 토큰 자동 생성
- [ ] 새 앱에 필요한 추가 설정 파일이 있으면 각 앱의 README 참고

---

## 9. 기술 스택

- 프론트엔드: 순수 HTML + CSS + JavaScript (프레임워크 없음)
- 백엔드: Python (KOSIS API 호출 등)
- 로컬 서버: Python HTTP 서버 (`127.0.0.1:8765`)
- 외부 라이브러리: SheetJS (엑셀), Plotly.js (차트) — CDN으로 로드
- 동기화: Git + GitHub
- 실행: Windows VBS/배치 파일 (`Local Desk 실행.bat` → `scripts/Local Desk 실행.vbs` → `scripts/Local Desk 실행.bat`)

---

## 10. 현재 모듈 목록

| 모듈 | 위치 | 설명 |
|------|------|------|
| KOSIS 통계 | `apps/kosis/` + `portal/pages/kosis.*` | KOSIS 공공 통계 조회, 피벗 테이블, 차트, 엑셀 내보내기 |
| 보고서 기초자료 | `apps/report_data/` + `portal/pages/report_data.*` | 상하수도 보고서 기초자료 항목별 KOSIS 후보 추천, 미리보기, 선택 요약 |

새 모듈을 추가하면 이 표도 갱신할 것.

# Local Desk — 프로젝트 스펙

이 문서는 AI(Claude 등)가 이 프로젝트에서 작업할 때 반드시 먼저 읽어야 할 규칙과 맥락입니다.
사람이 읽어도 되지만, 주된 목적은 AI에게 프로젝트를 정확히 이해시키는 것입니다.

---

## 1. 프로젝트 개요

- 개인용 로컬 포털. 브라우저에서 `127.0.0.1:8765`로 접속하는 홈페이지.
- 집과 회사 PC를 Git(GitHub)으로 동기화.
- KOSIS 통계 조회, 달력, 앱 관리 등 업무/개인 도구를 한곳에 모음.
- 회사에서 만든 기능들을 정리하고, 새로운 도구를 계속 추가해나가는 것이 목표.

---

## 2. 아키텍처 원칙

**코어를 유연하게 유지하면서, 다양한 모듈(앱)을 붙이는 방식으로 개발한다.**

### 코어 (`portal/`)

홈페이지 UI, 탭 라우팅, 공통 스타일, Git 관리 화면 등 기반 기능.

- `portal/index.html` — 메인 HTML
- `portal/app.js` — 코어 로직 (탭 전환, Git 연동, 달력, 메모 등)
- `portal/styles.css` — 전체 스타일
- `portal/apps.js` — 앱 목록 등록 (여기에 새 앱을 추가하면 포털에 표시됨)
- `portal/data/portal-data.json` — 동기화되는 포털 데이터 (일정 등)

코어는 **가볍고 범용적**으로 유지할 것. 특정 기능의 로직을 코어에 직접 넣지 않는다.

### 앱 모듈 (`apps/`)

각 기능은 독립된 모듈로, `apps/기능명/` 폴더에 넣는다.

- 각 앱은 코어에 최소한으로 의존해야 한다.
- 현재 앱: `apps/kosis/` (KOSIS 통계 조회 도구)
- 포털과의 연결은 `portal/apps.js`에 항목을 추가하는 방식.
- 웹 화면이 필요한 앱은 `portal/pages/`에 HTML/JS를 둘 수 있음.

### 기타 폴더

- `scripts/` — 실행 스크립트 (배치 파일, VBS 등)
- `local/` — Git에 올리지 않는 PC별 개인 파일, 비밀 키, 캐시 등

---

## 3. 코딩 규칙

- **빌드 도구 없음.** webpack, vite 등 사용하지 않는다. HTML/JS/CSS 직접 작성.
- **단일 파일 선호.** 하나의 기능이 여러 파일로 흩어지지 않게 한다.
- **한글 사용 가능.** 파일명, 변수명 외의 UI 텍스트와 주석은 한글로 작성해도 됨.
- **코어 수정은 신중하게.** `portal/index.html`, `portal/app.js`, `portal/styles.css`는 모든 기능의 기반이므로 기존 구조를 깨뜨리지 않도록 주의.
- 새 기능은 `apps/` 아래에 모듈로 추가하는 것을 우선으로 한다.
- 포털에 앱을 등록하는 방법은 `portal/apps.js`의 기존 항목을 참고.

---

## 4. 새 앱 모듈 추가 절차

1. `apps/새기능/` 폴더 생성
2. 필요한 코드 작성 (Python 백엔드, HTML 프론트 등)
3. 웹 화면이 필요하면 `portal/pages/새기능.html`, `portal/pages/새기능.js` 생성
4. `portal/apps.js`에 앱 항목 추가:
   ```js
   {
     id: "새기능",
     name: "표시 이름",
     type: "page",          // "page" = 포털 내 웹화면, "local" = 로컬 프로그램 실행
     path: "./pages/새기능.html",
     description: "설명",
     initials: "XX"
   }
   ```
5. API 키가 필요하면 `config.example.py` 패턴 사용 (아래 보안사항 참고)
6. README.md 폴더 구조에 새 앱 추가

---

## 5. 보안사항 — 반드시 지킬 것

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

## 6. Git 동기화 규칙

Git에 올리는 것:
`portal/`, `apps/`, `scripts/`의 코드, `portal/data/portal-data.json`, `README.md`, `SPEC.md`, `.gitignore`

Git에 올리지 않는 것:
`config.py`, `.env`, `local/` 안의 실제 파일, 엑셀/CSV/ZIP 결과물, `.venv/`, `__pycache__/`

자세한 제외 규칙은 `.gitignore` 파일 참고.

---

## 7. 새 PC 세팅 체크리스트

clone 후 아래 항목을 수동으로 설정해야 함:

- [ ] `apps/kosis/config.example.py` → `config.py`로 복사, API 키 입력
- [ ] `local/secrets/google-calendar-credentials.json` — Google OAuth JSON 저장
- [ ] Local Desk 달력 화면에서 Google Calendar '연결' → 토큰 자동 생성
- [ ] 새 앱에 필요한 추가 설정 파일이 있으면 각 앱의 README 참고

---

## 8. 기술 스택

- 프론트엔드: 순수 HTML + CSS + JavaScript (프레임워크 없음)
- 백엔드: Python (KOSIS API 호출 등)
- 로컬 서버: Python HTTP 서버 (`127.0.0.1:8765`)
- 동기화: Git + GitHub
- 실행: Windows 배치 파일 (`Local Desk 실행.bat`)

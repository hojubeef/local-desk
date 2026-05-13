# Local Desk

개인용 로컬 홈페이지 겸 작업 도구 모음.
집과 회사 PC를 Git으로 동기화하면서, 업무 도구를 하나의 포털에서 사용합니다.

상세 개발 규칙과 AI 작업 가이드는 [SPEC.md](./SPEC.md)를 참고하세요.

## 폴더 구조

```text
portal/          홈페이지 UI (코어)
apps/            기능 모듈 (KOSIS 통계, 보고서 기초자료 등)
scripts/         실행 스크립트
local/           이 PC에서만 쓰는 개인 파일 (Git 제외)
overtime_journal_app/
                 야근일지 단독 앱. Local Desk/KOSIS와 별도 관리
```

`overtime_journal_app/`은 같은 저장소 안에 둘 수 있지만, 구조상 Local Desk의 하위 모듈이 아니라 별도 Windows 앱입니다.
KOSIS나 Local Desk를 수정할 때는 이 폴더를 기본 참고 대상으로 보지 않고, 야근일지 관련 작업일 때만 해당 폴더의 README/SPEC을 읽습니다.

## 실행

```text
Local Desk 실행.bat
```

기본 실행은 CMD 창을 열고 로컬 서버를 켭니다. 브라우저에서 `http://127.0.0.1:8765`로 접속됩니다.
브라우저 창을 닫거나 포털 안에서 페이지를 이동해도 서버는 자동 종료되지 않습니다. 종료하려면 CMD 창에서 `Ctrl+C`를 누르거나 창을 닫습니다.

## 새 PC 세팅

clone 후 아래 파일은 직접 설정해야 합니다 (Git에 안 올라감):

1. `apps/kosis/config.example.py` → `config.py`로 복사 후 API 키 입력
2. `apps/map_capture/config.example.py` → `config.py`로 복사 후 카카오 JavaScript 키 입력 (지도 캡처를 쓸 경우에만)
3. `local/secrets/google-calendar-credentials.json` — Google OAuth 인증 파일 저장
4. 달력 화면에서 '연결' 누르면 토큰 자동 생성

## Git 관리

Local Desk의 Git 탭에서 커밋, 받기, 올리기를 할 수 있습니다.

- 커밋: 변경사항을 로컬 Git에 기록
- 받기: GitHub에서 최신 내용 가져오기
- 올리기: 커밋한 내용을 GitHub에 전송

## 현재 모듈

- `apps/kosis/` — KOSIS 통계 검색, 미리보기, 엑셀 내보내기
- `apps/report_data/` — 상하수도 보고서 기초자료 후보 추천
- `apps/map_capture/` — 카카오맵 영역 지정 + PNG 캡처

## 별도 관리 앱

- `overtime_journal_app/` — 야근일지 입력/집계 단독 앱. 별도 [README](./overtime_journal_app/README.md)와 [SPEC](./overtime_journal_app/SPEC.md)을 따릅니다.

Local Desk 왼쪽 사이드바의 `기능` 아래 `야근일지` 메뉴는 이 단독 앱의 EXE를 선택하고 실행하는 런처 역할만 합니다. Local Desk 자체 실행 옵션은 별도 `설정` 메뉴에서 관리합니다.
빌드 결과물인 `overtime_journal_app/dist/`, `build/`, `*.spec` 등은 Git에 올리지 않습니다.

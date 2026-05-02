# Local Desk

개인용 로컬 홈페이지와 기능 모음 작업 공간입니다.

## 폴더 구조

```text
portal/                      홈페이지 UI
portal/data/portal-data.json 집/회사에서 동기화할 포털 데이터
apps/                        실제 기능 모듈
apps/kosis/                  KOSIS 통계 조회 도구
scripts/                     실행 스크립트
local/                       이 PC에서만 쓰는 개인 파일
```

## Git에 올리는 것과 안 올리는 것

Git에 올리는 것:

- `portal/`, `apps/`, `scripts/`의 코드와 화면 파일
- `portal/data/portal-data.json`
- `README.md`, `.gitignore`

Git에 올리지 않는 것:

- API 키가 들어간 `apps/kosis/config.py`
- `.env`, `*.env`
- `local/` 안의 실제 개인 파일
- 엑셀, CSV, ZIP 같은 결과물이나 백업 파일
- `.venv/`, `__pycache__/` 같은 실행 캐시

참고: `portal/data/portal-data.json`에는 직접 만든 로컬 일정만 저장합니다.
Google Calendar에서 가져온 일정 제목/메모/캘린더 ID는 Git 동기화 파일에 저장하지 않습니다.

## KOSIS 설정

새 PC에서는 `apps/kosis/config.example.py`를 `apps/kosis/config.py`로 복사한 뒤
본인 KOSIS API 키를 넣으면 됩니다. 실제 `config.py`는 Git에 올리지 않습니다.

## Google Calendar 연동

Google Calendar는 OAuth 방식으로 연결합니다.

Git에 올리지 않는 파일:

- `local/secrets/google-calendar-credentials.json`
- `local/secrets/google-calendar-token.json`

연동하려면 Google Cloud에서 Calendar API를 켜고, OAuth 클라이언트 유형을 `Desktop app`으로 만든 뒤
다운로드한 JSON 파일을 `local/secrets/google-calendar-credentials.json` 이름으로 저장합니다.

그 다음 Local Desk의 달력 화면에서 `연결`을 누르고 Google 승인을 마치면
토큰이 `local/secrets/google-calendar-token.json`에 저장됩니다. 이 토큰도 Git에 올리지 않습니다.

Google Calendar에서 가져온 일정 내용은 화면 표시와 로컬 브라우저 저장용으로만 사용하고,
`portal/data/portal-data.json`에는 저장하지 않습니다.

## 실행

```text
Local Desk 실행.bat
```

위 파일을 실행하면 로컬 서버가 켜지고 브라우저에서 Local Desk가 열립니다.
KOSIS 웹 화면은 `http://127.0.0.1:8765` 안에서 Python 로직을 호출합니다.

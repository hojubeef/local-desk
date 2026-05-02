# Local Desk

개인용 로컬 홈페이지 겸 작업 도구 모음.
집과 회사 PC를 Git으로 동기화하면서, 업무 도구를 하나의 포털에서 사용합니다.

상세 개발 규칙과 AI 작업 가이드는 [SPEC.md](./SPEC.md)를 참고하세요.

## 폴더 구조

```text
portal/          홈페이지 UI (코어)
apps/            기능 모듈 (KOSIS 통계 등)
scripts/         실행 스크립트
local/           이 PC에서만 쓰는 개인 파일 (Git 제외)
```

## 실행

```text
Local Desk 실행.bat
```

로컬 서버가 켜지고 브라우저에서 `http://127.0.0.1:8765`로 접속됩니다.

## 새 PC 세팅

clone 후 아래 파일은 직접 설정해야 합니다 (Git에 안 올라감):

1. `apps/kosis/config.example.py` → `config.py`로 복사 후 API 키 입력
2. `local/secrets/google-calendar-credentials.json` — Google OAuth 인증 파일 저장
3. 달력 화면에서 '연결' 누르면 토큰 자동 생성

## Git 관리

Local Desk의 Git 탭에서 커밋, 받기, 올리기를 할 수 있습니다.

- 커밋: 변경사항을 로컬 Git에 기록
- 받기: GitHub에서 최신 내용 가져오기
- 올리기: 커밋한 내용을 GitHub에 전송

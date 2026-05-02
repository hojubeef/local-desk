# Local-Only Files

이 폴더는 이 PC에서만 쓰는 개인 파일을 모아두는 곳입니다.

Git에는 이 안내 파일과 빈 폴더 표시 파일만 올라가고, 실제 내용물은 올라가지 않습니다.

## 폴더 기준

```text
local/
  secrets/    API 키, 토큰, 비밀번호, 개인 설정 메모
  exports/    엑셀, CSV 같은 내보내기 결과물
  cache/      임시 캐시 파일
  logs/       실행 로그
  archives/   zip 백업 파일, 예전 자료 묶음
```

## 주의

- KOSIS API 키가 들어간 `apps/kosis/config.py`는 Git에 올리지 않습니다.
- 다른 PC에서는 `apps/kosis/config.example.py`를 `apps/kosis/config.py`로 복사한 뒤 API 키를 직접 넣습니다.
- Google Calendar 인증 파일은 `local/secrets/google-calendar-credentials.json`에 둡니다.
- Google Calendar 로그인 토큰은 `local/secrets/google-calendar-token.json`에 저장되며 Git에 올리지 않습니다.
- Google Calendar에서 가져온 일정 내용은 Git 동기화 파일에 저장하지 않습니다.
- 집/회사에서 같이 쓰고 싶은 포털 데이터는 `portal/data/portal-data.json`에 저장되고 Git으로 동기화됩니다.

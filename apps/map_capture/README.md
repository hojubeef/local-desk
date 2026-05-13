# Map Capture

지도 위에서 원하는 영역을 사각형/정사각형으로 드래그해 지정하고, 지정한 해상도의 PNG 파일로 저장하는 도구.

1차 버전은 카카오맵만 지원합니다 (일반 / 스카이뷰 / 하이브리드).

## 키 발급 (카카오)

1. [Kakao Developers](https://developers.kakao.com) 로그인
2. 내 애플리케이션 > 애플리케이션 추가 (앱 이름 자유롭게)
3. 만든 앱 진입 > 앱 설정 > **플랫폼** > Web 플랫폼 등록
   - 사이트 도메인에 다음을 모두 추가:
     - `http://127.0.0.1:8765`
     - `http://localhost:8765`
4. 앱 키 메뉴에서 **JavaScript 키** 복사
5. `apps/map_capture/config.py`의 `KAKAO_JS_KEY = "복사한_키"` 에 붙여넣기
6. Local Desk를 재시작 (서버를 다시 띄움)

## 사용법

1. Local Desk 포털에서 `지도 캡처` 메뉴 진입
2. 검색창에서 위치 검색 또는 지도 직접 이동
3. 뷰 타입 선택 (일반 / 스카이뷰 / 하이브리드)
4. 영역 선택 모드 켜기 > 지도 위에서 드래그
   - Shift 누른 채 드래그하면 정사각형 비율 고정
5. 출력 해상도(가로/세로 픽셀) 입력, 배율(1x/2x/3x) 선택
6. `PNG 저장` 클릭 > 브라우저 다운로드 폴더로 저장

## 알아둘 것

- 카카오맵 JavaScript SDK는 인터넷 연결이 있어야 동작합니다 (CDN에서 로드).
- 캡처는 `html2canvas` 라이브러리를 사용합니다. 브라우저 환경에 따라 타일 일부가 늦게 그려져 캡처에 빠질 수 있습니다. 그럴 땐 잠시 기다린 뒤 다시 시도하세요.
- 카카오 무료 일/월 호출량 안에서 사용하는 것을 권장합니다 (개인 용도라면 거의 문제되지 않습니다).
- 캡처 PNG는 직접 만든 지도 화면이지만, 카카오맵 약관에 따라 상업적 배포에는 제한이 있을 수 있습니다.

## 파일

```text
apps/map_capture/
  config.example.py   API 키 템플릿 (Git 포함)
  config.py           실제 키 (.gitignore에 의해 Git 제외)
  README.md           이 파일

portal/pages/
  map_capture.html    화면
  map_capture.js      드래그 박스, 캡처 로직
```

API 라우트는 `apps/kosis/web_server.py`에 `/api/map-capture/config`로 추가되어 있습니다.

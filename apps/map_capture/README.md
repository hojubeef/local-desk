# Map Capture

네이버 지도에서 사각형 영역을 선택하고 PNG로 저장하는 Local Desk 도구입니다.

이 버전은 카카오맵을 제외하고 네이버 지도만 사용합니다. 고화질 저장은 화면을 크게 캡처하는 방식이 아니라, 선택 영역의 좌표 범위를 네이버 Static Map 최대 줌 조각으로 받아 합성합니다.

## 키 설정

`apps/map_capture/config.example.py`를 `config.py`로 복사한 뒤 값을 입력합니다.

```python
NAVER_CLIENT_ID = "네이버_Maps_Application_Client_ID"
NAVER_CLIENT_SECRET = "네이버_Maps_Application_Client_Secret"
NAVER_MONTHLY_LIMIT = 3_000_000

# 선택 사항: 네이버 Cost and Usage API 조회용
NCLOUD_ACCESS_KEY = ""
NCLOUD_SECRET_KEY = ""
NCLOUD_BILLING_KEYWORD = "Maps"

# 선택 사항: 장소명/상호명 검색용
NAVER_LOCAL_SEARCH_CLIENT_ID = ""
NAVER_LOCAL_SEARCH_CLIENT_SECRET = ""
```

`NAVER_CLIENT_ID`는 지도 미리보기 SDK와 Static Map 호출에 필요합니다.
`NAVER_CLIENT_SECRET`은 서버에서 Static Map 조각 이미지를 받을 때 필요합니다.
네이버 Maps Application의 Web 서비스 URL에는 `http://127.0.0.1:8765`와 `http://localhost:8765`를 등록해두세요.

`NCLOUD_ACCESS_KEY`와 `NCLOUD_SECRET_KEY`는 네이버 클라우드 계정의 API 인증키입니다. 입력하면 Cost and Usage API를 호출해 네이버 쪽 산정 사용량도 조회합니다. Maps Application의 Client Secret과는 다른 값입니다.

`NAVER_LOCAL_SEARCH_CLIENT_ID`와 `NAVER_LOCAL_SEARCH_CLIENT_SECRET`은 네이버 개발자 센터의 Search API > 지역 검색 키입니다. 입력하면 "강남역", "서울시청", 상호명 같은 장소 검색 결과가 검색 목록과 지도 마커로 표시됩니다. 비워두면 주소 검색만 동작합니다.

## 사용법

1. Local Desk 포털 > 지도 캡처
2. 위치 검색 또는 직접 지도 이동
   - 주소 검색은 네이버 Maps Geocoding으로 처리
   - 장소명/상호명은 네이버 Local Search 키가 있을 때 목록과 마커로 표시
   - 검색 마커가 필요 없으면 `마커 지우기`로 목록과 마커를 지울 수 있음
3. 지도 위 툴바에서 일반 / 위성 / 하이브리드 선택
4. 지도 위 `영역 선택` > 드래그로 사각형 선택
5. 저장 품질 선택
   - 현재 화면: 지금 보고 있는 지도 줌으로 받아 지정한 저장 크기로 리사이즈
   - 직접 지정: 입력한 줌 레벨과 픽셀 배율로 좌표 범위 원본 저장
   - 최고 화질: Static Map level 20, scale 2로 고정 저장
6. PNG 저장

저장에 성공하면 선택 영역의 남서/북동 좌표, 뷰 타입, 화질, 출력 크기, API 호출 수가 화면의 캡처 로그에 남습니다. 로그 항목을 누르면 해당 좌표 범위로 다시 이동해 선택 영역을 복원합니다.

## 화질 방식

네이버 지도에서 보이는 줌이 500m 정도로 넓어도, 최대줌 방식은 선택 사각형의 남서/북동 좌표를 계산한 뒤 level 20 기준 픽셀 범위로 변환합니다. 그 범위를 512px 단위 조각으로 나누어 Static Map API를 여러 번 호출하고, 브라우저 캔버스에서 순서대로 붙여 하나의 PNG로 저장합니다.

선택 영역이 넓거나 줌 레벨/픽셀 배율이 높을수록 Static Map API 조각 수가 늘어납니다. 호출 수나 결과 이미지가 매우 커져도 앱이 임의로 막지는 않고, 화면에 경고만 표시한 뒤 저장을 시도합니다. 다만 브라우저/PC 메모리 한계를 넘으면 저장이 실패할 수 있습니다.

## 사용량 표시

화면에는 두 가지 사용량을 표시합니다.

- 앱 계산 사용량: 이 Local Desk 도구가 이번 달 호출한 Static Map 조각 수입니다. `local/cache/map_capture_usage.json`에 저장됩니다.
- 네이버 산정 사용량: `NCLOUD_ACCESS_KEY`, `NCLOUD_SECRET_KEY`가 있을 때 Cost and Usage API에서 Maps 관련 사용량 행을 조회해 표시합니다.

네이버 Maps Static Map 무료량은 대표 계정 1개 기준 월 3,000,000건입니다. 실제 계약이나 과금 기준이 다르면 `NAVER_MONTHLY_LIMIT` 값을 조정하세요.

## 파일

```text
apps/map_capture/
  config.example.py   API 키 템플릿
  config.py           실제 키(.gitignore)
  README.md

portal/pages/
  map_capture.html    화면
  map_capture.js      네이버 지도/영역 선택/Static Map 합성 로직

apps/kosis/
  web_server.py       설정, 사용량, Static Map 프록시 API
```

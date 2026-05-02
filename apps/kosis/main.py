# ============================================================
# main.py - 실행 파일
# ============================================================
#
# [이 파일의 역할]
# "뭘 할지"만 적는 곳. 실제 복잡한 로직은 kosis_client.py에 있음.
# 마치 리모컨처럼, 버튼(함수)만 누르면 됨.
#
# [실행 방법]
# 1. config.py에 본인 API 키 입력
# 2. 터미널에서: python main.py
# ============================================================

from config import KOSIS_API_KEY
from kosis_client import KosisClient

# ── API 키 확인 ──────────────────────────────────────────
if KOSIS_API_KEY == "여기에_본인_API키_입력":
    print("⚠️  config.py에서 API 키를 본인 키로 변경해주세요!")
    print("   파일 위치: config.py")
    exit()

# ── KOSIS 클라이언트 생성 ────────────────────────────────
client = KosisClient(KOSIS_API_KEY)


# ============================================================
# 🔍 기능 1: 상주시 인구 관련 통계표 검색
# ============================================================
print("\n" + "🟦" * 35)
print("  기능 1: 경상북도 상주시 인구 관련 통계표 검색")
print("🟦" * 35)

# 검색 실행
results = client.search("상주시 인구")

# 검색 결과 출력
client.print_search_results(results)


# ============================================================
# 📂 각 통계표의 상세 분류항목 확인
# ============================================================
if results is not None and len(results) > 0:
    print("\n\n" + "🟩" * 35)
    print("  각 통계표의 분류항목 상세 보기")
    print("🟩" * 35)

    # 상위 5개 통계표의 분류항목만 조회 (전부 하면 오래 걸림)
    # [min이란?] 둘 중 작은 값을 선택. 결과가 5개 미만이면 그만큼만.
    check_count = min(5, len(results))
    
    for i in range(check_count):
        row = results.iloc[i]
        org_id = row.get('기관ID', '')
        tbl_id = row.get('통계표ID', '')
        tbl_name = row.get('통계표명', '')

        print(f"\n{'─' * 70}")
        print(f"📊 [{i+1}] {tbl_name}")
        print(f"   기관ID: {org_id} | 통계표ID: {tbl_id}")

        # 수록정보(기간) 조회
        period_df = client.get_period_info(org_id, tbl_id)
        if period_df is not None and len(period_df) > 0:
            row_p = period_df.iloc[0]
            cycle = row_p.get('수록주기', '?')
            start = row_p.get('수록기간시작일', '?')
            end = row_p.get('수록기간종료일', '?')
            print(f"   📅 수록주기: {cycle} | 기간: {start} ~ {end}")

        # 분류항목 조회
        cat_df = client.get_categories(org_id, tbl_id)
        client.print_categories(cat_df)


# ============================================================
# 🔎 기능 2: 분류항목 기반 유사 통계표 검색 (예시)
# ============================================================
# 아래 주석을 풀면 실행됩니다.
# "상주시" 지역에서 "총인구" 항목이 있는 통계표를 찾습니다.
#
# print("\n\n" + "🟨" * 35)
# print("  기능 2: '총인구' 항목이 포함된 유사 통계표 검색")
# print("🟨" * 35)
#
# similar = client.find_similar_tables("상주시", "총인구")
# client.print_similar_results(similar)

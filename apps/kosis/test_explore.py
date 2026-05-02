# ============================================================
# test_explore.py - KOSIS API 구조 탐색 스크립트
# ============================================================
# 
# [목적]
# KOSIS API에서 실제로 어떤 데이터가 나오는지 확인하는 스크립트.
# 이걸 돌려보면 "아~ 이렇게 생겼구나" 하고 이해할 수 있음.
#
# [사용법]
# 1. config.py에 API 키 입력
# 2. python test_explore.py 실행
# ============================================================

from config import KOSIS_API_KEY
from PublicDataReader import Kosis
import pandas as pd

# 출력 설정 (표가 잘려서 안 보이는 것 방지)
pd.set_option('display.max_columns', None)
pd.set_option('display.max_colwidth', 40)
pd.set_option('display.width', 200)
pd.set_option('display.max_rows', 50)

api = Kosis(KOSIS_API_KEY)


# ============================================================
# 1. 통합검색: "상주시 수도"로 검색하면 뭐가 나오나?
# ============================================================
print("=" * 80)
print("📌 1단계: 통합검색 - '상주시 수도' 검색 결과")
print("=" * 80)

df_search = api.get_data(
    "KOSIS통합검색",
    searchNm="상주시 수도",
    resultCount="10",
)

if df_search is not None:
    print(f"\n검색 결과: {len(df_search)}건")
    print(f"\n📋 컬럼 목록: {list(df_search.columns)}")
    print("\n--- 검색 결과 미리보기 ---")
    # 주요 컬럼만 출력
    cols = ['기관명', '통계표명', '기관ID', '통계표ID', '수록기간시작일', '수록기간종료일']
    available_cols = [c for c in cols if c in df_search.columns]
    print(df_search[available_cols].to_string())

    # 첫 번째 결과의 전체 데이터 확인
    print("\n\n--- 첫 번째 결과 전체 필드 ---")
    for col in df_search.columns:
        val = df_search.iloc[0].get(col, '')
        print(f"  {col}: {val}")
else:
    print("검색 결과 없음!")


# ============================================================
# 2. 통합검색: "상주시 급수량"으로는?
# ============================================================
print("\n\n" + "=" * 80)
print("📌 2단계: 통합검색 - '상주시 급수량' 검색 결과")
print("=" * 80)

df_search2 = api.get_data(
    "KOSIS통합검색",
    searchNm="상주시 급수량",
    resultCount="10",
)

if df_search2 is not None:
    print(f"\n검색 결과: {len(df_search2)}건")
    cols = ['기관명', '통계표명', '기관ID', '통계표ID']
    available_cols = [c for c in cols if c in df_search2.columns]
    print(df_search2[available_cols].to_string())
else:
    print("검색 결과 없음!")


# ============================================================
# 3. 통합검색: "급수량"만으로는?
# ============================================================
print("\n\n" + "=" * 80)
print("📌 3단계: 통합검색 - '급수량' 검색 결과")
print("=" * 80)

df_search3 = api.get_data(
    "KOSIS통합검색",
    searchNm="급수량",
    resultCount="10",
)

if df_search3 is not None:
    print(f"\n검색 결과: {len(df_search3)}건")
    cols = ['기관명', '통계표명', '기관ID', '통계표ID', '수록기간시작일', '수록기간종료일']
    available_cols = [c for c in cols if c in df_search3.columns]
    print(df_search3[available_cols].to_string())
else:
    print("검색 결과 없음!")


# ============================================================
# 4. "급수량" 검색 결과 중 첫번째 통계표의 분류항목 확인
# ============================================================
print("\n\n" + "=" * 80)
print("📌 4단계: 분류항목 구조 확인")
print("=" * 80)

# 급수량 검색 결과가 있으면 그걸로, 없으면 "상수도"로 재검색
target_df = df_search3
if target_df is None or len(target_df) == 0:
    print("\n'급수량' 결과 없음. '상수도'로 재검색...")
    target_df = api.get_data(
        "KOSIS통합검색",
        searchNm="상수도",
        resultCount="10",
    )

if target_df is not None and len(target_df) > 0:
    # 상위 3개 통계표의 분류항목 확인
    check_count = min(3, len(target_df))
    
    for i in range(check_count):
        row = target_df.iloc[i]
        org_id = row.get('기관ID', '')
        tbl_id = row.get('통계표ID', '')
        tbl_name = row.get('통계표명', '')
        
        print(f"\n\n{'─' * 70}")
        print(f"📊 [{i+1}] {tbl_name}")
        print(f"   기관: {row.get('기관명', '')} | 기관ID: {org_id} | 통계표ID: {tbl_id}")
        
        # 분류항목 조회
        cat_df = api.get_data(
            "통계표설명",
            "분류항목",
            orgId=org_id,
            tblId=tbl_id,
        )
        
        if cat_df is not None and len(cat_df) > 0:
            print(f"\n   📋 분류항목 컬럼: {list(cat_df.columns)}")
            print(f"   📋 총 {len(cat_df)}개 항목")
            
            # 분류명별로 그룹화
            if '분류명' in cat_df.columns and '분류값명' in cat_df.columns:
                grouped = cat_df.groupby('분류명')
                for name, group in grouped:
                    items = group['분류값명'].tolist()
                    print(f"\n   📁 [{name}] ({len(items)}개)")
                    # 앞 15개만 표시
                    for j, item in enumerate(items[:15]):
                        print(f"      {j+1}. {item}")
                    if len(items) > 15:
                        print(f"      ... 외 {len(items)-15}개")
            else:
                print("\n   전체 데이터:")
                print(cat_df.to_string())
        else:
            print("   ⚠️ 분류항목 없음")


# ============================================================
# 5. "상주시 인구"로 검색 → 분류항목에서 "상주시" 찾기
# ============================================================
print("\n\n" + "=" * 80)
print("📌 5단계: '상주시 인구' 검색 → 분류항목에서 '상주시' 존재 여부 확인")
print("=" * 80)

df_pop = api.get_data(
    "KOSIS통합검색",
    searchNm="상주시 인구",
    resultCount="5",
)

if df_pop is not None and len(df_pop) > 0:
    for i in range(min(3, len(df_pop))):
        row = df_pop.iloc[i]
        org_id = row.get('기관ID', '')
        tbl_id = row.get('통계표ID', '')
        tbl_name = row.get('통계표명', '')
        
        print(f"\n{'─' * 70}")
        print(f"📊 [{i+1}] {tbl_name} ({row.get('기관명', '')})")
        
        cat_df = api.get_data(
            "통계표설명",
            "분류항목",
            orgId=org_id,
            tblId=tbl_id,
        )
        
        if cat_df is not None and '분류값명' in cat_df.columns:
            # "상주" 포함 항목 찾기
            matched = cat_df[cat_df['분류값명'].str.contains('상주', na=False)]
            if len(matched) > 0:
                print(f"   ✅ '상주' 포함 항목 {len(matched)}건 발견:")
                for _, m in matched.iterrows():
                    print(f"      - [{m.get('분류명', '?')}] {m.get('분류값명', '?')}")
            else:
                print(f"   ❌ '상주' 포함 항목 없음")
                
            # 어떤 분류명들이 있는지
            if '분류명' in cat_df.columns:
                categories = cat_df['분류명'].unique().tolist()
                print(f"   📁 분류명 종류: {categories}")
        else:
            print(f"   ⚠️ 분류항목 조회 실패")


# ============================================================
# 6. 유사항목 검색이 안 되는 이유 확인
# ============================================================
print("\n\n" + "=" * 80)
print("📌 6단계: 유사항목 검색 디버깅")
print("   '상주시'로 검색 → 각 결과에서 '급수량' 분류항목 확인")
print("=" * 80)

df_region = api.get_data(
    "KOSIS통합검색",
    searchNm="상주시",
    resultCount="20",
)

if df_region is not None:
    print(f"\n'상주시' 검색 결과: {len(df_region)}건\n")
    
    found_any = False
    for i, row in df_region.iterrows():
        org_id = row.get('기관ID', '')
        tbl_id = row.get('통계표ID', '')
        tbl_name = row.get('통계표명', '')
        
        cat_df = api.get_data(
            "통계표설명",
            "분류항목",
            orgId=org_id,
            tblId=tbl_id,
        )
        
        has_supply = False
        if cat_df is not None and '분류값명' in cat_df.columns:
            matched = cat_df[cat_df['분류값명'].str.contains('급수', na=False)]
            if len(matched) > 0:
                has_supply = True
                found_any = True
                print(f"  ✅ [{tbl_name}] → '급수' 포함 항목 발견:")
                for _, m in matched.iterrows():
                    print(f"      - [{m.get('분류명', '?')}] {m.get('분류값명', '?')}")
        
        if not has_supply:
            print(f"  ❌ [{tbl_name}] → '급수' 없음")
    
    if not found_any:
        print("\n💡 '상주시' 검색 결과 중 '급수' 관련 분류항목이 하나도 없습니다.")
        print("   → '상수도', '수도', '급수' 등 다른 키워드로 직접 검색하면 나올 수 있습니다.")
        print("   → 유사항목 검색은 '지역명'으로 먼저 검색한 결과 안에서만 찾기 때문에,")
        print("     '상주시' 검색 결과에 상수도 관련 통계표가 없으면 찾을 수 없습니다.")


print("\n\n" + "=" * 80)
print("✅ 탐색 완료!")
print("=" * 80)

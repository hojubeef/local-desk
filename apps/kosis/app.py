# ============================================================
# app.py - KOSIS 통계 조회 도구 GUI (v2)
# ============================================================
#
# [v2 변경사항]
# - 통계표 목록을 행정구역별 트리 폴더로 표시
# - 매칭 경로 태그 ([통계표명] [분류항목] [키워드])
# - 기관명 뒤에 (전국)/(지역) 표시
# - 중복 폴더 (여러 행정구역에 걸친 통계표)
# - 프로그레스바 추가
#
# [실행 방법]
# 1. config.py에 API 키 입력
# 2. 터미널에서: python app.py
# ============================================================

import tkinter as tk
from tkinter import ttk, messagebox
import threading

from config import KOSIS_API_KEY
from kosis_client import KosisClient


# ============================================================
# 시/도, 시/군/구 데이터
# ============================================================
REGION_DATA = {
    "전국": ["전체"],
    "서울특별시": ["전체", "종로구", "중구", "용산구", "성동구", "광진구", "동대문구",
                "중랑구", "성북구", "강북구", "도봉구", "노원구", "은평구", "서대문구",
                "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구",
                "관악구", "서초구", "강남구", "송파구", "강동구"],
    "부산광역시": ["전체", "중구", "서구", "동구", "영도구", "부산진구", "동래구",
                "남구", "북구", "해운대구", "사하구", "금정구", "강서구", "연제구",
                "수영구", "사상구", "기장군"],
    "대구광역시": ["전체", "중구", "동구", "서구", "남구", "북구", "수성구", "달서구", "달성군", "군위군"],
    "인천광역시": ["전체", "중구", "동구", "미추홀구", "연수구", "남동구", "부평구",
                "계양구", "서구", "강화군", "옹진군"],
    "광주광역시": ["전체", "동구", "서구", "남구", "북구", "광산구"],
    "대전광역시": ["전체", "동구", "중구", "서구", "유성구", "대덕구"],
    "울산광역시": ["전체", "중구", "남구", "동구", "북구", "울주군"],
    "세종특별자치시": ["전체"],
    "경기도": ["전체", "수원시", "성남시", "의정부시", "안양시", "부천시", "광명시",
             "평택시", "동두천시", "안산시", "고양시", "과천시", "구리시", "남양주시",
             "오산시", "시흥시", "군포시", "의왕시", "하남시", "용인시", "파주시",
             "이천시", "안성시", "김포시", "화성시", "광주시", "양주시", "포천시",
             "여주시", "연천군", "가평군", "양평군"],
    "강원특별자치도": ["전체", "춘천시", "원주시", "강릉시", "동해시", "태백시", "속초시",
                  "삼척시", "홍천군", "횡성군", "영월군", "평창군", "정선군", "철원군",
                  "화천군", "양구군", "인제군", "고성군", "양양군"],
    "충청북도": ["전체", "청주시", "충주시", "제천시", "보은군", "옥천군", "영동군",
              "증평군", "진천군", "괴산군", "음성군", "단양군"],
    "충청남도": ["전체", "천안시", "공주시", "보령시", "아산시", "서산시", "논산시",
              "계룡시", "당진시", "금산군", "부여군", "서천군", "청양군", "홍성군",
              "예산군", "태안군"],
    "전북특별자치도": ["전체", "전주시", "군산시", "익산시", "정읍시", "남원시", "김제시",
                  "완주군", "진안군", "무주군", "장수군", "임실군", "순창군", "고창군", "부안군"],
    "전라남도": ["전체", "목포시", "여수시", "순천시", "나주시", "광양시", "담양군",
              "곡성군", "구례군", "고흥군", "보성군", "화순군", "장흥군", "강진군",
              "해남군", "영암군", "무안군", "함평군", "영광군", "장성군", "완도군",
              "진도군", "신안군"],
    "경상북도": ["전체", "포항시", "경주시", "김천시", "안동시", "구미시", "영주시",
              "영천시", "상주시", "문경시", "경산시", "의성군", "청송군", "영양군",
              "영덕군", "청도군", "고령군", "성주군", "칠곡군", "예천군", "봉화군",
              "울진군", "울릉군"],
    "경상남도": ["전체", "창원시", "진주시", "통영시", "사천시", "김해시", "밀양시",
              "거제시", "양산시", "의령군", "함안군", "창녕군", "고성군", "남해군",
              "하동군", "산청군", "함양군", "거창군", "합천군"],
    "제주특별자치도": ["전체", "제주시", "서귀포시"],
}


class KosisApp:
    """KOSIS 통계 조회 도구 GUI (v2)."""

    def __init__(self, root):
        self.root = root
        self.root.title("KOSIS 통계 조회 도구 v2")
        self.root.geometry("1200x700")
        self.root.minsize(1000, 550)

        # API 키 확인
        if KOSIS_API_KEY == "여기에_본인_API키_입력":
            messagebox.showwarning("API 키 필요", "config.py 파일에서 API 키를 본인 키로 변경해주세요!")
            return

        self.client = KosisClient(KOSIS_API_KEY)

        # 검색 결과 저장
        # [왜 저장하나?]
        # 폴더 구조의 통계표를 클릭했을 때 상세 정보를 보여주려면
        # 검색 결과를 기억하고 있어야 함.
        self.folder_data = None       # 폴더별 통계표 정보
        self.all_tables = {}          # iid → 통계표 정보 매핑
        self.selected_table_info = None
        self.data_options = None
        self.data_item_map = {}
        self.data_tree_selection_state = {}

        self._setup_styles()
        self._build_ui()

    # ==========================================================
    # 스타일 설정
    # ==========================================================
    def _setup_styles(self):
        style = ttk.Style()
        style.theme_use('clam')

        style.configure('TFrame', background='#F5F5F5')
        style.configure('TLabel', background='#F5F5F5', font=('맑은 고딕', 10))
        style.configure('TLabelframe', background='#F5F5F5', font=('맑은 고딕', 10, 'bold'))
        style.configure('TLabelframe.Label', background='#F5F5F5', font=('맑은 고딕', 10, 'bold'))
        style.configure('TButton', font=('맑은 고딕', 10), padding=6)
        style.configure('TCheckbutton', background='#F5F5F5', font=('맑은 고딕', 9))

        style.configure('Header.TLabel', font=('맑은 고딕', 13, 'bold'), background='#3949AB', foreground='white', padding=10)
        style.configure('SubHeader.TLabel', font=('맑은 고딕', 10, 'bold'), background='#F5F5F5')
        style.configure('Info.TLabel', font=('맑은 고딕', 9), background='#F5F5F5', foreground='#666666')
        style.configure('Status.TLabel', font=('맑은 고딕', 9), background='#E0E0E0', padding=4)
        style.configure('ApiUsage.TLabel', font=('맑은 고딕', 9), background='#F5F5F5', foreground='#333333')

        style.configure('Search.TButton', font=('맑은 고딕', 10, 'bold'))
        style.configure('Similar.TButton', font=('맑은 고딕', 9))

        # Treeview 스타일
        style.configure('Treeview', font=('맑은 고딕', 10), rowheight=28)
        style.configure('Treeview.Heading', font=('맑은 고딕', 10, 'bold'))
        # 폴더 선택 시 색상
        style.map('Treeview', background=[('selected', '#C5CAE9')])

    # ==========================================================
    # UI 구성
    # ==========================================================
    def _build_ui(self):
        """
        전체 UI 구성.
        ┌─────────────────────────────────────────────┐
        │              상단 타이틀 바                    │
        ├────────┬──────────────┬─────────────────────┤
        │ 왼쪽   │   가운데      │    오른쪽             │
        │ 패널   │ (폴더 트리)   │  (상세 정보)          │
        │(검색)  │              │                      │
        ├────────┴──────────────┴─────────────────────┤
        │       프로그레스바 + 상태바                     │
        └─────────────────────────────────────────────┘
        """
        # ── 타이틀 ──────────────────────────────────
        ttk.Label(
            self.root, text="  KOSIS 통계 조회 도구", style='Header.TLabel'
        ).pack(fill=tk.X)

        # ── 메인 영역 ──────────────────────────────
        main_pane = ttk.PanedWindow(self.root, orient=tk.HORIZONTAL)
        main_pane.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)

        left_frame = self._build_left_panel(main_pane)
        main_pane.add(left_frame, weight=1)

        center_frame = self._build_center_panel(main_pane)
        main_pane.add(center_frame, weight=2)

        right_frame = self._build_right_panel(main_pane)
        main_pane.add(right_frame, weight=2)

        # ── 하단: 프로그레스바 + 상태바 ───────────────
        bottom_frame = ttk.Frame(self.root)
        bottom_frame.pack(fill=tk.X, side=tk.BOTTOM)

        self.progress_var = tk.IntVar(value=0)
        self.progress_bar = ttk.Progressbar(
            bottom_frame, variable=self.progress_var, maximum=100, mode='determinate'
        )
        self.progress_bar.pack(fill=tk.X, padx=4, pady=(2, 0))

        api_usage_frame = ttk.Frame(bottom_frame)
        api_usage_frame.pack(fill=tk.X, padx=4, pady=(2, 0))

        self.api_usage_var = tk.StringVar(
            value="API 최근 60초 0/1000회 (0.0%) | 이번 검색 0회 | 누적 0회"
        )
        ttk.Label(
            api_usage_frame, textvariable=self.api_usage_var, style='ApiUsage.TLabel'
        ).pack(side=tk.LEFT, padx=(0, 8))

        self.api_usage_progress_var = tk.IntVar(value=0)
        self.api_usage_bar = ttk.Progressbar(
            api_usage_frame,
            variable=self.api_usage_progress_var,
            maximum=100,
            mode='determinate',
            length=180,
        )
        self.api_usage_bar.pack(side=tk.LEFT, fill=tk.X, expand=True)

        self.status_var = tk.StringVar(value="  준비 완료 | 시/도와 시/군/구를 선택하고 검색해보세요.")
        ttk.Label(bottom_frame, textvariable=self.status_var, style='Status.TLabel').pack(fill=tk.X)
        self._refresh_api_usage()

    # ----------------------------------------------------------
    # 왼쪽 패널: 검색 조건
    # ----------------------------------------------------------
    def _build_left_panel(self, parent):
        frame = ttk.Frame(parent, width=260)

        # ── 검색 조건 ────────────────────────────────
        search_group = ttk.LabelFrame(frame, text="  검색 조건", padding=10)
        search_group.pack(fill=tk.X, padx=5, pady=(5, 2))

        ttk.Label(search_group, text="시/도 선택").pack(anchor=tk.W)
        self.sido_var = tk.StringVar()
        self.sido_combo = ttk.Combobox(
            search_group, textvariable=self.sido_var,
            values=list(REGION_DATA.keys()), state='readonly', width=25
        )
        self.sido_combo.pack(fill=tk.X, pady=(0, 8))
        self.sido_combo.bind('<<ComboboxSelected>>', self._on_sido_change)

        ttk.Label(search_group, text="시/군/구 선택").pack(anchor=tk.W)
        self.sigungu_var = tk.StringVar()
        self.sigungu_combo = ttk.Combobox(
            search_group, textvariable=self.sigungu_var, state='readonly', width=25
        )
        self.sigungu_combo.pack(fill=tk.X, pady=(0, 8))

        ttk.Label(search_group, text="검색 키워드").pack(anchor=tk.W)
        self.keyword_var = tk.StringVar(value="인구")
        keyword_entry = ttk.Entry(search_group, textvariable=self.keyword_var, width=25)
        keyword_entry.pack(fill=tk.X, pady=(0, 10))
        keyword_entry.bind('<Return>', lambda e: self._on_search())

        self.subregion_search_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            search_group,
            text="읍면동 보강검색",
            variable=self.subregion_search_var,
        ).pack(anchor=tk.W, pady=(0, 8))

        ttk.Button(
            search_group, text="🔍  검색 (통합+지역지표)",
            style='Search.TButton', command=self._on_search
        ).pack(fill=tk.X, pady=(2, 0))

        ttk.Label(
            search_group,
            text="※ 통합검색 결과에 e-지방지표를 더해\n   선택 지역이 있는 표를 함께 찾습니다.",
            style='Info.TLabel'
        ).pack(anchor=tk.W, pady=(6, 0))

        # ── 유사 항목 검색 ────────────────────────────
        similar_group = ttk.LabelFrame(frame, text="  유사 항목 검색", padding=10)
        similar_group.pack(fill=tk.X, padx=5, pady=(8, 5))

        ttk.Label(similar_group, text="분류항목 키워드").pack(anchor=tk.W)
        self.similar_keyword_var = tk.StringVar()
        similar_entry = ttk.Entry(similar_group, textvariable=self.similar_keyword_var, width=25)
        similar_entry.pack(fill=tk.X, pady=(0, 8))
        similar_entry.bind('<Return>', lambda e: self._on_similar_search())

        ttk.Button(
            similar_group, text="🔎  유사 항목 찾기",
            style='Similar.TButton', command=self._on_similar_search
        ).pack(fill=tk.X, pady=(2, 0))

        ttk.Label(
            similar_group,
            text="※ 지역 고정 후, 해당 항목이 포함된\n   통계표를 찾습니다.",
            style='Info.TLabel'
        ).pack(anchor=tk.W, pady=(6, 0))

        # 기본값: 경상북도 > 상주시
        self.sido_combo.set("경상북도")
        self._on_sido_change(None)
        self.sigungu_combo.set("상주시")

        return frame

    # ----------------------------------------------------------
    # 가운데 패널: 폴더 트리 구조
    # ----------------------------------------------------------
    def _build_center_panel(self, parent):
        """
        [v2 핵심 변경]
        기존: 단순 리스트
        변경: 행정구역별 폴더 트리 (📁 전국 / 📁 경상북도 / 📁 상주시)
        
        Treeview의 트리 기능을 활용.
        폴더(부모 노드)를 만들고, 통계표(자식 노드)를 넣는 구조.
        """
        frame = ttk.Frame(parent)

        header = ttk.Label(frame, text="  통계표 목록 (추천도순)", style='SubHeader.TLabel')
        header.pack(fill=tk.X, padx=5, pady=(5, 2))

        self.result_count_var = tk.StringVar(value="검색 결과가 여기에 표시됩니다.")
        ttk.Label(frame, textvariable=self.result_count_var, style='Info.TLabel').pack(fill=tk.X, padx=8)

        list_frame = ttk.Frame(frame)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # [columns 변경] 추천도 + 지역수준 + 세부분류 + 최신시점 + 출처
        columns = ('추천', '지역수준', '세부분류', '최신', '출처')
        self.table_tree = ttk.Treeview(
            list_frame, columns=columns,
            show='tree headings', selectmode='browse'
        )

        self.table_tree.heading('#0', text='통계표명', anchor=tk.W)
        self.table_tree.heading('추천', text='추천', anchor=tk.W)
        self.table_tree.heading('지역수준', text='지역수준', anchor=tk.W)
        self.table_tree.heading('세부분류', text='세부분류', anchor=tk.W)
        self.table_tree.heading('최신', text='최신시점', anchor=tk.W)
        self.table_tree.heading('출처', text='출처', anchor=tk.W)

        self.table_tree.column('#0', width=300, minwidth=180)
        self.table_tree.column('추천', width=70, minwidth=60)
        self.table_tree.column('지역수준', width=160, minwidth=100)
        self.table_tree.column('세부분류', width=190, minwidth=120)
        self.table_tree.column('최신', width=80, minwidth=60)
        self.table_tree.column('출처', width=120, minwidth=80)

        scrollbar = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self.table_tree.yview)
        self.table_tree.configure(yscrollcommand=scrollbar.set)

        self.table_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)

        self.table_tree.bind('<<TreeviewSelect>>', self._on_table_select)

        return frame

    # ----------------------------------------------------------
    # 오른쪽 패널: 상세 정보
    # ----------------------------------------------------------
    def _build_right_panel(self, parent):
        frame = ttk.Frame(parent)

        header = ttk.Label(frame, text="  상세 정보", style='SubHeader.TLabel')
        header.pack(fill=tk.X, padx=5, pady=(5, 2))

        self.detail_title_var = tk.StringVar(value="통계표를 선택하면 상세 정보가 표시됩니다.")
        ttk.Label(
            frame, textvariable=self.detail_title_var,
            font=('맑은 고딕', 11, 'bold'), background='#F5F5F5', wraplength=380
        ).pack(fill=tk.X, padx=8, pady=(5, 2))

        data_group = ttk.LabelFrame(frame, text="  데이터 조회", padding=6)
        data_group.pack(fill=tk.X, padx=5, pady=(4, 2))

        data_row = ttk.Frame(data_group)
        data_row.pack(fill=tk.X)

        ttk.Label(data_row, text="항목").pack(side=tk.LEFT)
        self.data_item_var = tk.StringVar(value="자동")
        self.data_item_combo = ttk.Combobox(
            data_row, textvariable=self.data_item_var,
            values=["자동"], state='readonly', width=22
        )
        self.data_item_combo.pack(side=tk.LEFT, padx=(4, 8), fill=tk.X, expand=True)

        ttk.Label(data_row, text="최근").pack(side=tk.LEFT)
        self.latest_count_var = tk.IntVar(value=5)
        self.latest_count_spin = ttk.Spinbox(
            data_row, from_=1, to=30, textvariable=self.latest_count_var, width=4
        )
        self.latest_count_spin.pack(side=tk.LEFT, padx=(4, 2))
        ttk.Label(data_row, text="개").pack(side=tk.LEFT)

        ttk.Button(
            data_group, text="조건 트리 설정", command=self._open_data_condition_tree
        ).pack(fill=tk.X, pady=(6, 2))

        ttk.Button(
            data_group, text="선택 데이터 미리보기", command=self._on_preview_data
        ).pack(fill=tk.X, pady=(2, 2))

        self.data_status_var = tk.StringVar(value="통계표를 선택하면 조회 옵션이 준비됩니다.")
        ttk.Label(data_group, textvariable=self.data_status_var, style='Info.TLabel').pack(fill=tk.X)

        self.classification_summary_var = tk.StringVar(value="")
        ttk.Label(
            data_group,
            textvariable=self.classification_summary_var,
            style='Info.TLabel',
            wraplength=420,
            justify=tk.LEFT
        ).pack(fill=tk.X, pady=(2, 0))

        detail_frame = ttk.Frame(frame)
        detail_frame.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        self.detail_text = tk.Text(
            detail_frame, wrap=tk.WORD, font=('맑은 고딕', 10),
            bg='#FFFFFF', relief='flat', padx=10, pady=10, state='disabled'
        )
        detail_scroll = ttk.Scrollbar(detail_frame, orient=tk.VERTICAL, command=self.detail_text.yview)
        self.detail_text.configure(yscrollcommand=detail_scroll.set)
        self.detail_text.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        detail_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        # 텍스트 태그 설정
        self.detail_text.tag_configure('title', font=('맑은 고딕', 11, 'bold'), foreground='#1A237E')
        self.detail_text.tag_configure('subtitle', font=('맑은 고딕', 10, 'bold'), foreground='#3949AB')
        self.detail_text.tag_configure('highlight', font=('맑은 고딕', 10, 'bold'), foreground='#D84315', background='#FFF3E0')
        self.detail_text.tag_configure('info', font=('맑은 고딕', 10), foreground='#333333')
        self.detail_text.tag_configure('dim', font=('맑은 고딕', 9), foreground='#888888')
        self.detail_text.tag_configure('item', font=('맑은 고딕', 10), foreground='#444444')
        self.detail_text.tag_configure('tag_tblname', font=('맑은 고딕', 9, 'bold'), foreground='#1565C0', background='#E3F2FD')
        self.detail_text.tag_configure('tag_category', font=('맑은 고딕', 9, 'bold'), foreground='#2E7D32', background='#E8F5E9')
        self.detail_text.tag_configure('tag_keyword', font=('맑은 고딕', 9, 'bold'), foreground='#E65100', background='#FFF3E0')
        self.detail_text.tag_configure('tag_agency_national', font=('맑은 고딕', 9), foreground='#5E35B1', background='#EDE7F6')
        self.detail_text.tag_configure('tag_agency_local', font=('맑은 고딕', 9), foreground='#00695C', background='#E0F2F1')
        self.detail_text.tag_configure('matched', font=('맑은 고딕', 10, 'bold'), foreground='#1B5E20', background='#E8F5E9')
        self.detail_text.tag_configure('region_tag', font=('맑은 고딕', 9, 'bold'), foreground='#AD1457', background='#FCE4EC')

        return frame

    # ==========================================================
    # 이벤트 핸들러
    # ==========================================================

    def _on_sido_change(self, event):
        sido = self.sido_var.get()
        if sido in REGION_DATA:
            self.sigungu_combo['values'] = REGION_DATA[sido]
            self.sigungu_combo.set(REGION_DATA[sido][0])

    def _on_search(self):
        """검색 버튼 클릭 → 상세 분석 검색 실행."""
        sido = self.sido_var.get()
        sigungu = self.sigungu_var.get()
        keyword = self.keyword_var.get().strip()

        if not sido:
            messagebox.showinfo("알림", "시/도를 선택해주세요.")
            return
        if not keyword:
            messagebox.showinfo("알림", "검색 키워드를 입력해주세요.")
            return

        self._clear_results()
        self.client.begin_api_usage_session()
        self.progress_var.set(0)
        self._set_status("검색 및 분석 시작...")

        thread = threading.Thread(
            target=self._search_thread,
            args=(sido, sigungu, keyword, self.subregion_search_var.get()),
            daemon=True
        )
        thread.start()

    def _search_thread(self, sido, sigungu, keyword, include_subregion_search=False):
        """별도 스레드에서 검색 + 분류 실행."""

        def progress_callback(progress, message):
            self.root.after(0, self._update_progress, progress, message)

        folders = self.client.search_and_classify(
            sido,
            sigungu,
            keyword,
            callback=progress_callback,
            include_subregion_search=include_subregion_search,
        )

        self.root.after(0, self._display_folder_results, folders)

    def _update_progress(self, progress, message):
        """프로그레스바와 상태바를 업데이트합니다."""
        self.progress_var.set(progress)
        self._set_status(message)

    def _display_folder_results(self, folders):
        """
        폴더 구조로 검색 결과를 트리에 표시합니다.

        [트리 구조 만드는 방법]
        1. 폴더(부모 노드)를 먼저 삽입
        2. 각 폴더 안에 통계표(자식 노드)를 삽입
        
        [iid 체계]
        - 폴더: "folder_전국", "folder_경상북도" 등
        - 통계표: "table_0", "table_1" 등 (고유 번호)
        
        [왜 iid가 필요한가?]
        나중에 클릭했을 때 "어떤 통계표를 클릭했는지" 알아내기 위해.
        iid로 all_tables 딕셔너리에서 해당 통계표 정보를 찾음.
        """
        if folders is None:
            self.result_count_var.set("검색 결과가 없습니다.")
            self._set_status("검색 결과 없음")
            return

        self.folder_data = folders
        self.all_tables = {}
        table_counter = 0

        # 폴더 표시 순서 정의 (시군구 → 시도 → 전국 → 중복 → 미분류)
        sigungu = self.sigungu_var.get()
        sido = self.sido_var.get()

        # [왜 순서를 직접 지정하나?]
        # 사용자가 가장 관심 있는 "내 지역" 데이터를 맨 위에 보여주기 위해.
        order = []
        if sigungu and sigungu != "전체" and sigungu in folders:
            order.append(sigungu)
        if sido and sido != "전국" and sido in folders:
            order.append(sido)
        if "전국" in folders:
            order.append("전국")
        if "중복" in folders:
            order.append("중복")
        if "미분류" in folders:
            order.append("미분류")
        # 혹시 빠진 폴더가 있으면 추가
        for k in folders:
            if k not in order:
                order.append(k)

        total_tables = 0

        for folder_name in order:
            tables = folders[folder_name]
            if not tables:
                continue

            # 폴더 아이콘 결정
            if folder_name == "중복":
                icon = "📂"
            elif folder_name == "미분류":
                icon = "📁"
            else:
                icon = "📁"

            # 폴더 노드 삽입
            folder_iid = f"folder_{folder_name}"
            self.table_tree.insert(
                '', tk.END,
                iid=folder_iid,
                text=f"{icon} {folder_name} ({len(tables)}건)",
                values=('', '', '', '', ''),
                open=True  # 기본적으로 펼쳐진 상태
            )

            # 통계표 노드 삽입
            for table_info in tables:
                table_iid = f"table_{table_counter}"
                table_counter += 1

                source = table_info.get('검색소스', 'KOSIS통합검색')
                score = table_info.get('추천점수', 0)
                recommend_display = f"{table_info.get('추천도', '보통')} {score}"
                region_display = table_info.get('지역수준요약', '미확인')
                detail_display = table_info.get('세부분류요약', '미확인')
                latest_display = table_info.get('최신시점', table_info.get('수록기간종료일', '?'))

                # 행정구역 태그 (중복 폴더일 때 표시)
                tbl_display = table_info.get('통계표명', '')
                if folder_name == "중복":
                    regions_str = "+".join(table_info.get('행정구역', []))
                    tbl_display = f"{tbl_display} [{regions_str}]"

                self.table_tree.insert(
                    folder_iid, tk.END,
                    iid=table_iid,
                    text=tbl_display,
                    values=(
                        recommend_display,
                        region_display,
                        detail_display,
                        latest_display,
                        source,
                    )
                )

                # 매핑 저장 (클릭 시 상세 정보용)
                self.all_tables[table_iid] = table_info

                total_tables += 1

        self.result_count_var.set(f"총 {total_tables}건 | 추천도순 | 폴더 {len(folders)}개")
        self.progress_var.set(100)
        self._set_status(f"검색 완료: {total_tables}건, 폴더 {len(folders)}개")

    def _on_table_select(self, event):
        """통계표 클릭 시 상세 정보를 표시합니다."""
        selected = self.table_tree.selection()
        if not selected:
            return

        iid = selected[0]

        # 폴더를 클릭한 경우 → 무시 (펼치기/접기만)
        if iid.startswith("folder_"):
            return

        # 통계표를 클릭한 경우
        if iid not in self.all_tables:
            return

        table_info = self.all_tables[iid]
        self.selected_table_info = table_info
        self.detail_title_var.set(table_info['통계표명'])

        # 상세 정보 표시
        self._display_detail(table_info)
        self._load_data_options(table_info)

    def _display_detail(self, table_info):
        """상세 정보를 오른쪽 패널에 표시합니다."""
        self.detail_text.configure(state='normal')
        self.detail_text.delete('1.0', tk.END)

        tbl_name = table_info['통계표명']
        org_name = table_info['기관명']
        org_id = table_info['기관ID']
        tbl_id = table_info['통계표ID']
        agency_level = table_info['기관수준']
        match_types = table_info['매칭경로']
        region_levels = table_info['행정구역']
        cat_df = table_info.get('분류항목_df')
        source = table_info.get('검색소스', 'KOSIS통합검색')

        # ── 기본 정보 ────────────────────────────────
        self.detail_text.insert(tk.END, f"{tbl_name}\n", 'title')
        self.detail_text.insert(tk.END, f"기관ID: {org_id}  |  통계표ID: {tbl_id}\n", 'dim')
        self.detail_text.insert(tk.END, f"검색소스: {source}", 'dim')
        if table_info.get('주제명'):
            self.detail_text.insert(tk.END, f"  |  주제: {table_info.get('주제명')}", 'dim')
        if table_info.get('지역코드'):
            self.detail_text.insert(tk.END, f"  |  지역코드: {table_info.get('지역코드')}", 'dim')
        self.detail_text.insert(tk.END, "\n", 'dim')
        if table_info.get('추천도'):
            self.detail_text.insert(
                tk.END,
                f"추천도: {table_info.get('추천도')} ({table_info.get('추천점수', 0)}점)"
                f"  |  {table_info.get('추천사유', '')}\n",
                'info'
            )
        if table_info.get('지역수준요약') or table_info.get('세부분류요약'):
            self.detail_text.insert(
                tk.END,
                f"지역수준: {table_info.get('지역수준요약', '미확인')}"
                f"  |  세부분류: {table_info.get('세부분류요약', '미확인')}\n",
                'info'
            )

        # 기관 수준 태그
        self.detail_text.insert(tk.END, f"\n기관: {org_name} ")
        if agency_level == "전국":
            self.detail_text.insert(tk.END, " 전국기관 ", 'tag_agency_national')
        else:
            self.detail_text.insert(tk.END, " 지역기관 ", 'tag_agency_local')

        # 매칭 경로 태그
        self.detail_text.insert(tk.END, "\n매칭: ")
        for mt in match_types:
            if mt == "통계표명":
                self.detail_text.insert(tk.END, f" {mt} ", 'tag_tblname')
            elif mt == "분류항목":
                self.detail_text.insert(tk.END, f" {mt} ", 'tag_category')
            else:
                self.detail_text.insert(tk.END, f" {mt} ", 'tag_keyword')
            self.detail_text.insert(tk.END, " ")

        # 행정구역 태그
        self.detail_text.insert(tk.END, "\n행정구역: ")
        for region in region_levels:
            self.detail_text.insert(tk.END, f" {region} ", 'region_tag')
            self.detail_text.insert(tk.END, " ")

        self.detail_text.insert(tk.END, "\n")

        # ── 수록 정보 ────────────────────────────────
        self.detail_text.insert(tk.END, "\n📅 수록 정보\n", 'subtitle')
        self.detail_text.insert(tk.END, "─" * 40 + "\n", 'dim')

        # 수록정보 API 호출 (이건 빠르므로 메인 스레드에서 OK)
        self._set_status(f"'{tbl_name}' 수록 정보 조회 중...")
        period_df = self.client.get_period_info(org_id, tbl_id)

        if period_df is not None and len(period_df) > 0:
            row = period_df.iloc[0]
            cycle = row.get('수록주기', '정보 없음')
            start = row.get('수록기간시작일', '?')
            end = row.get('수록기간종료일', '?')
            self.detail_text.insert(tk.END, f"  수록주기: {cycle}\n", 'info')
            self.detail_text.insert(tk.END, f"  수록기간: {start} ~ {end}\n\n", 'info')
        elif table_info.get('수록주기'):
            self.detail_text.insert(tk.END, f"  수록주기: {table_info.get('수록주기')}\n", 'info')
            self.detail_text.insert(tk.END, f"  수록기간: {table_info['수록기간']}\n\n", 'info')
        else:
            self.detail_text.insert(tk.END, f"  수록기간: {table_info['수록기간']}\n\n", 'info')

        # ── 분류항목 ─────────────────────────────────
        self.detail_text.insert(tk.END, "📂 분류항목\n", 'subtitle')
        self.detail_text.insert(tk.END, "─" * 40 + "\n", 'dim')

        if cat_df is not None and len(cat_df) > 0 and '분류명' in cat_df.columns:
            current_region = self.sigungu_var.get()
            grouped = cat_df.groupby('분류명')

            for name, group in grouped:
                self.detail_text.insert(tk.END, f"\n  📁 [{name}]\n", 'subtitle')

                items = group['분류값명'].tolist()
                for item in items[:30]:
                    if current_region and current_region in str(item):
                        self.detail_text.insert(tk.END, f"    ▸ {item}\n", 'highlight')
                    else:
                        self.detail_text.insert(tk.END, f"    ▸ {item}\n", 'item')

                if len(items) > 30:
                    self.detail_text.insert(tk.END, f"    ... 외 {len(items)-30}개\n", 'dim')
        else:
            self.detail_text.insert(tk.END, "  분류항목 정보를 불러올 수 없습니다.\n", 'dim')

        self.detail_text.configure(state='disabled')
        self._set_status(f"'{tbl_name}' 상세 정보 표시 완료")

    def _current_region(self):
        sigungu = self.sigungu_var.get()
        if sigungu and sigungu != "전체":
            return sigungu
        return self.sido_var.get()

    def _load_data_options(self, table_info):
        """선택 통계표의 데이터 조회 옵션을 백그라운드에서 준비합니다."""
        self.data_options = None
        self.data_item_map = {}
        self.data_item_combo['values'] = ["자동"]
        self.data_item_combo.set("자동")
        self.data_status_var.set("데이터 조회 옵션 준비 중...")
        self.classification_summary_var.set("")

        region = self._current_region()
        table_key = (table_info.get('기관ID'), table_info.get('통계표ID'))

        thread = threading.Thread(
            target=self._load_data_options_thread,
            args=(table_info, region, table_key),
            daemon=True
        )
        thread.start()

    def _load_data_options_thread(self, table_info, region, table_key):
        options = self.client.get_data_selection_options(
            table_info.get('기관ID', ''),
            table_info.get('통계표ID', ''),
            region_name=region,
        )
        self.root.after(0, self._apply_data_options, table_key, options)

    def _apply_data_options(self, table_key, options):
        if not self.selected_table_info:
            return
        current_key = (
            self.selected_table_info.get('기관ID'),
            self.selected_table_info.get('통계표ID'),
        )
        if current_key != table_key:
            return

        self.data_options = options
        self.data_item_map = {}
        self.data_tree_selection_state = self._default_data_tree_state(options)

        display_values = ["자동"]
        for item in options.get("items", [])[:200]:
            label = f"{item.get('name', '')} ({item.get('id', '')})"
            display_values.append(label)
            self.data_item_map[label] = item.get('id', '')

        self.data_item_combo['values'] = display_values
        self.data_item_combo.set("자동")

        period = options.get("period", {})
        region_match = options.get("region_match")
        if region_match:
            region_text = f"{region_match.get('name')}({region_match.get('id')})"
        else:
            region_text = "지역 자동 매칭 없음"

        self.data_status_var.set(
            f"지역: {region_text} | 주기: {period.get('label', '?')} | 항목 {len(options.get('items', []))}개"
        )
        self._update_data_condition_summary()
        summaries = self.client.summarize_selection_options(options)
        if summaries:
            self.classification_summary_var.set("\n".join(summaries[:4]))
        else:
            self.classification_summary_var.set("")

    def _default_data_tree_state(self, options):
        state = {
            "ITEM": set(),
            "objects": {},
        }

        items = options.get("items", [])
        if items:
            state["ITEM"].add(items[0].get("id", "ALL"))
        else:
            state["ITEM"].add("ALL")

        for group in options.get("objects", []):
            obj_id = group.get("obj_id", "")
            selected = group.get("selected")
            if selected:
                state["objects"][obj_id] = {selected.get("id", "ALL")}
            else:
                state["objects"][obj_id] = {"ALL"}

        return state

    def _copy_data_tree_state(self):
        return {
            "ITEM": set(self.data_tree_selection_state.get("ITEM", set())),
            "objects": {
                obj_id: set(values)
                for obj_id, values in self.data_tree_selection_state.get("objects", {}).items()
            },
        }

    def _selection_names(self, values, id_to_name):
        if not values:
            return "자동"
        if "ALL" in values:
            return "전체"
        names = [id_to_name.get(value, value) for value in values]
        if len(names) <= 2:
            return ", ".join(names)
        return f"{', '.join(names[:2])} 외 {len(names) - 2}개"

    def _update_data_condition_summary(self):
        if not self.data_options:
            return

        item_names = {
            item.get("id", ""): item.get("name", "")
            for item in self.data_options.get("items", [])
        }
        item_text = self._selection_names(
            self.data_tree_selection_state.get("ITEM", set()),
            item_names,
        )

        object_texts = []
        for group in self.data_options.get("objects", [])[:3]:
            obj_id = group.get("obj_id", "")
            id_to_name = {
                value.get("id", ""): value.get("name", "")
                for value in group.get("values", [])
            }
            selected = self.data_tree_selection_state.get("objects", {}).get(obj_id, {"ALL"})
            object_texts.append(f"{group.get('obj_name', obj_id)}={self._selection_names(selected, id_to_name)}")

        suffix = " | ".join(object_texts)
        if suffix:
            self.data_status_var.set(f"항목={item_text} | {suffix}")
        else:
            self.data_status_var.set(f"항목={item_text}")

    def _open_data_condition_tree(self):
        if not self.data_options:
            messagebox.showinfo("알림", "먼저 통계표를 선택해 조회 옵션을 불러와주세요.")
            return

        temp_state = self._copy_data_tree_state()

        window = tk.Toplevel(self.root)
        window.title("조회 조건 트리 설정")
        window.geometry("620x620")
        window.minsize(520, 420)

        info = ttk.Label(
            window,
            text="  더블클릭 또는 Space로 항목과 분류값을 선택합니다.",
            style='Info.TLabel'
        )
        info.pack(fill=tk.X, padx=8, pady=(8, 4))

        quick_row = ttk.Frame(window)
        quick_row.pack(fill=tk.X, padx=8, pady=(0, 4))

        tree_frame = ttk.Frame(window)
        tree_frame.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)

        tree = ttk.Treeview(tree_frame, columns=("code",), show="tree headings", selectmode="browse")
        tree.heading("#0", text="항목/분류")
        tree.heading("code", text="코드")
        tree.column("#0", width=390, minwidth=220)
        tree.column("code", width=150, minwidth=80)

        y_scroll = ttk.Scrollbar(tree_frame, orient=tk.VERTICAL, command=tree.yview)
        tree.configure(yscrollcommand=y_scroll.set)
        tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        y_scroll.pack(side=tk.RIGHT, fill=tk.Y)

        node_map = {}
        obj_value_nodes = {}
        region_match_iid = None

        item_root = tree.insert("", tk.END, text="항목", values=("",), open=True)
        for item in self.data_options.get("items", []):
            iid = tree.insert(item_root, tk.END, text=item.get("name", ""), values=(item.get("id", ""),))
            node_map[iid] = ("ITEM", "", item.get("id", ""), item.get("name", ""))

        for group in self.data_options.get("objects", []):
            obj_id = group.get("obj_id", "")
            group_iid = tree.insert(
                "",
                tk.END,
                text=f"{group.get('obj_name', obj_id)} ({obj_id})",
                values=("",),
                open=True,
            )

            all_iid = tree.insert(group_iid, tk.END, text="전체", values=("ALL",))
            node_map[all_iid] = ("OBJ", obj_id, "ALL", "전체")

            values = group.get("values", [])
            value_by_id = {value.get("id", ""): value for value in values}
            children = {}
            for value in values:
                up_id = value.get("up_id", "")
                parent_id = up_id if up_id in value_by_id else ""
                children.setdefault(parent_id, []).append(value)

            def add_value_nodes(parent_iid, parent_value_id=""):
                for value in children.get(parent_value_id, []):
                    value_id = value.get("id", "")
                    value_name = value.get("name", "")
                    child_iid = tree.insert(parent_iid, tk.END, text=value_name, values=(value_id,))
                    node_map[child_iid] = ("OBJ", obj_id, value_id, value_name)
                    obj_value_nodes[(obj_id, value_id)] = child_iid
                    add_value_nodes(child_iid, value_id)

            add_value_nodes(group_iid)

            selected_value = group.get("selected")
            if selected_value and region_match_iid is None:
                region_match_iid = obj_value_nodes.get((obj_id, selected_value.get("id", "")))

        def refresh_tree_marks():
            child_selection_cache = {}

            def descendant_node_ids(iid):
                if iid in child_selection_cache:
                    return child_selection_cache[iid]
                descendants = []
                for child_iid in tree.get_children(iid):
                    if child_iid in node_map:
                        descendants.append(child_iid)
                    descendants.extend(descendant_node_ids(child_iid))
                child_selection_cache[iid] = descendants
                return descendants

            for iid, (kind, obj_id, value_id, label) in node_map.items():
                if kind == "ITEM":
                    selected = value_id in temp_state.get("ITEM", set())
                    mark = "[x]" if selected else "[ ]"
                else:
                    selected_values = temp_state.get("objects", {}).get(obj_id, set())
                    selected = value_id in selected_values
                    descendant_iids = descendant_node_ids(iid)
                    descendant_values = [
                        node_map[child_iid][2]
                        for child_iid in descendant_iids
                        if node_map[child_iid][0] == "OBJ"
                    ]
                    selected_descendants = [
                        value for value in descendant_values
                        if value in selected_values
                    ]
                    if selected:
                        mark = "[x]"
                    elif selected_descendants:
                        mark = "[~]"
                    else:
                        mark = "[ ]"
                tree.item(iid, text=f"{mark} {label}")

        def toggle_selected(event=None):
            selected = tree.selection()
            if not selected:
                return
            iid = selected[0]
            if iid not in node_map:
                return

            kind, obj_id, value_id, _ = node_map[iid]
            if kind == "ITEM":
                selected_values = temp_state.setdefault("ITEM", set())
                if value_id in selected_values:
                    if len(selected_values) > 1:
                        selected_values.remove(value_id)
                else:
                    selected_values.add(value_id)
            else:
                object_state = temp_state.setdefault("objects", {})
                selected_values = object_state.setdefault(obj_id, {"ALL"})
                if value_id == "ALL":
                    object_state[obj_id] = {"ALL"}
                else:
                    if "ALL" in selected_values:
                        selected_values.clear()
                    if value_id in selected_values:
                        selected_values.remove(value_id)
                    else:
                        selected_values.add(value_id)
                    if not selected_values:
                        object_state[obj_id] = {"ALL"}

            refresh_tree_marks()

        def descendant_value_ids(iid, include_self=False):
            values = []
            if include_self and iid in node_map and node_map[iid][0] == "OBJ":
                values.append(node_map[iid][2])
            for child_iid in tree.get_children(iid):
                if child_iid in node_map and node_map[child_iid][0] == "OBJ":
                    values.append(node_map[child_iid][2])
                values.extend(descendant_value_ids(child_iid, include_self=False))
            return [value for value in values if value and value != "ALL"]

        def select_descendants_of_selected():
            selected = tree.selection()
            if not selected:
                messagebox.showinfo("알림", "하위 항목을 선택할 노드를 먼저 선택해주세요.")
                return
            iid = selected[0]
            if iid not in node_map:
                return
            kind, obj_id, value_id, _ = node_map[iid]
            if kind != "OBJ" or value_id == "ALL":
                return

            values = descendant_value_ids(iid, include_self=False)
            if not values:
                values = [value_id]
            object_state = temp_state.setdefault("objects", {})
            object_state[obj_id] = set(values)
            refresh_tree_marks()

        def select_region_descendants():
            if not region_match_iid:
                messagebox.showinfo("알림", "현재 선택 지역과 일치하는 트리 노드를 찾지 못했습니다.")
                return
            tree.selection_set(region_match_iid)
            tree.see(region_match_iid)
            select_descendants_of_selected()

        def clear_all_conditions():
            temp_state["ITEM"] = set()
            items = self.data_options.get("items", [])
            if items:
                temp_state["ITEM"].add(items[0].get("id", "ALL"))
            else:
                temp_state["ITEM"].add("ALL")

            object_state = temp_state.setdefault("objects", {})
            for group in self.data_options.get("objects", []):
                object_state[group.get("obj_id", "")] = {"ALL"}
            refresh_tree_marks()

        def apply_and_close():
            self.data_tree_selection_state = temp_state
            self._update_data_condition_summary()
            window.destroy()

        button_row = ttk.Frame(window)
        button_row.pack(fill=tk.X, padx=8, pady=(4, 8))
        ttk.Button(quick_row, text="선택 지역 하위 전체", command=select_region_descendants).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(quick_row, text="선택 노드 하위 전체", command=select_descendants_of_selected).pack(side=tk.LEFT, padx=(0, 4))
        ttk.Button(quick_row, text="전체 해제", command=clear_all_conditions).pack(side=tk.LEFT)
        ttk.Button(button_row, text="적용", command=apply_and_close).pack(side=tk.RIGHT, padx=(4, 0))
        ttk.Button(button_row, text="취소", command=window.destroy).pack(side=tk.RIGHT)

        tree.bind("<Double-1>", toggle_selected)
        tree.bind("<space>", toggle_selected)
        refresh_tree_marks()

    def _on_preview_data(self):
        if not self.selected_table_info:
            messagebox.showinfo("알림", "먼저 통계표를 선택해주세요.")
            return

        try:
            latest_count = int(self.latest_count_var.get())
        except (TypeError, ValueError):
            latest_count = 5

        item_label = self.data_item_var.get()
        item_id = self.data_item_map.get(item_label)
        obj_selections = None
        if self.data_tree_selection_state:
            tree_item_ids = self.data_tree_selection_state.get("ITEM", set())
            if tree_item_ids:
                item_id = list(tree_item_ids)
            obj_selections = {
                obj_id: list(values)
                for obj_id, values in self.data_tree_selection_state.get("objects", {}).items()
            }
        table_info = self.selected_table_info
        region = self._current_region()

        self._set_status(f"'{table_info['통계표명']}' 선택 데이터 조회 중...")
        self.data_status_var.set("선택 데이터 조회 중...")

        thread = threading.Thread(
            target=self._preview_data_thread,
            args=(table_info, region, item_id, latest_count, obj_selections),
            daemon=True
        )
        thread.start()

    def _preview_data_thread(self, table_info, region, item_id, latest_count, obj_selections):
        df = self.client.fetch_selected_data(
            table_info.get('기관ID', ''),
            table_info.get('통계표ID', ''),
            region_name=region,
            item_id=item_id,
            latest_count=latest_count,
            obj_selections=obj_selections,
        )
        self.root.after(0, self._show_data_preview, table_info, df)

    def _show_data_preview(self, table_info, df):
        if df is None or len(df) == 0:
            self.data_status_var.set("조회된 데이터가 없습니다.")
            self._set_status("선택 데이터 조회 결과 없음")
            messagebox.showinfo("알림", "조회된 데이터가 없습니다.")
            return

        self.data_status_var.set(f"조회 완료: {len(df)}행")
        self._set_status(f"선택 데이터 조회 완료: {len(df)}행")

        window = tk.Toplevel(self.root)
        window.title(f"데이터 미리보기 - {table_info.get('통계표명', '')}")
        window.geometry("900x420")

        preferred_cols = [
            "PRD_DE", "C1_NM", "C2_NM", "C3_NM", "ITM_NM", "DT", "UNIT_NM", "LST_CHN_DE"
        ]
        columns = [col for col in preferred_cols if col in df.columns]
        if not columns:
            columns = list(df.columns[:8])

        header = ttk.Label(
            window,
            text=f"  {table_info.get('통계표명', '')} | {len(df)}행",
            style='SubHeader.TLabel'
        )
        header.pack(fill=tk.X, padx=6, pady=(6, 2))

        frame = ttk.Frame(window)
        frame.pack(fill=tk.BOTH, expand=True, padx=6, pady=6)

        tree = ttk.Treeview(frame, columns=columns, show='headings')
        y_scroll = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=tree.yview)
        x_scroll = ttk.Scrollbar(frame, orient=tk.HORIZONTAL, command=tree.xview)
        tree.configure(yscrollcommand=y_scroll.set, xscrollcommand=x_scroll.set)

        for col in columns:
            tree.heading(col, text=col)
            tree.column(col, width=120, minwidth=80, anchor=tk.W)

        for _, row in df.head(300).iterrows():
            tree.insert('', tk.END, values=[row.get(col, '') for col in columns])

        tree.grid(row=0, column=0, sticky='nsew')
        y_scroll.grid(row=0, column=1, sticky='ns')
        x_scroll.grid(row=1, column=0, sticky='ew')

        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)

    def _on_similar_search(self):
        """유사 항목 검색."""
        sido = self.sido_var.get()
        sigungu = self.sigungu_var.get()
        item_keyword = self.similar_keyword_var.get().strip()

        if not sido:
            messagebox.showinfo("알림", "시/도를 선택해주세요.")
            return
        if not item_keyword:
            messagebox.showinfo("알림", "분류항목 키워드를 입력해주세요.")
            return

        region = sigungu if (sigungu and sigungu != "전체") else sido

        self._clear_results()
        self.client.begin_api_usage_session()
        self.progress_var.set(0)
        self._set_status(f"'{region}'에서 '{item_keyword}' 유사 항목 검색 중...")

        thread = threading.Thread(
            target=self._similar_search_thread,
            args=(region, item_keyword),
            daemon=True
        )
        thread.start()

    def _similar_search_thread(self, region, item_keyword):
        def progress_callback(progress, message):
            self.root.after(0, self._update_progress, progress, message)

        results = self.client.find_similar_tables(
            region, item_keyword, callback=progress_callback
        )

        self.root.after(0, self._display_similar_results, results, item_keyword)

    def _display_similar_results(self, results, item_keyword):
        if not results:
            self.result_count_var.set(f"'{item_keyword}' 관련 통계표를 찾지 못했습니다.")
            self._set_status("유사 항목 검색 완료: 0건")
            self.progress_var.set(100)
            return

        self.result_count_var.set(f"'{item_keyword}' 포함 통계표: {len(results)}건")
        self.all_tables = {}

        # 정방향/역방향 분리
        forward = [r for r in results if r.get('검색방향') == '정방향']
        reverse = [r for r in results if r.get('검색방향') == '역방향']

        table_counter = 0

        # 정방향 결과 폴더
        if forward:
            folder_iid = "folder_정방향"
            self.table_tree.insert(
                '', tk.END, iid=folder_iid,
                text=f"📁 정방향: 지역명으로 검색 ({len(forward)}건)",
                values=('', '', ''), open=True
            )
            for table in forward:
                table_iid = f"table_{table_counter}"
                table_counter += 1
                matched_str = ", ".join(table['매칭항목'][:3])
                if len(table['매칭항목']) > 3:
                    matched_str += f" 외"
                period = f"{table['수록기간시작일']} ~ {table['수록기간종료일']}"

                self.table_tree.insert(
                    folder_iid, tk.END, iid=table_iid,
                    text=table['통계표명'],
                    values=(table['기관명'], period, f"정방향: {matched_str}")
                )
                self.all_tables[table_iid] = {
                    '통계표명': table['통계표명'],
                    '기관명': table['기관명'],
                    '기관ID': table['기관ID'],
                    '통계표ID': table['통계표ID'],
                    '수록기간': period,
                    '행정구역': [],
                    '매칭경로': ['분류항목(정방향)'],
                    '기관수준': self.client.classify_agency(table['기관명']),
                    '분류항목_df': None,
                }

        # 역방향 결과 폴더
        if reverse:
            folder_iid = "folder_역방향"
            self.table_tree.insert(
                '', tk.END, iid=folder_iid,
                text=f"📁 역방향: 항목 키워드로 검색 ({len(reverse)}건)",
                values=('', '', ''), open=True
            )
            for table in reverse:
                table_iid = f"table_{table_counter}"
                table_counter += 1
                matched_str = ", ".join(table['매칭항목'][:3])
                if len(table['매칭항목']) > 3:
                    matched_str += f" 외"
                period = f"{table['수록기간시작일']} ~ {table['수록기간종료일']}"

                self.table_tree.insert(
                    folder_iid, tk.END, iid=table_iid,
                    text=table['통계표명'],
                    values=(table['기관명'], period, f"역방향: {matched_str}")
                )
                self.all_tables[table_iid] = {
                    '통계표명': table['통계표명'],
                    '기관명': table['기관명'],
                    '기관ID': table['기관ID'],
                    '통계표ID': table['통계표ID'],
                    '수록기간': period,
                    '행정구역': [],
                    '매칭경로': ['분류항목(역방향)'],
                    '기관수준': self.client.classify_agency(table['기관명']),
                    '분류항목_df': None,
                }

        self.progress_var.set(100)
        self._set_status(f"유사 항목 검색 완료: {len(results)}건")

    # ==========================================================
    # 유틸리티
    # ==========================================================
    def _refresh_api_usage(self):
        snapshot = self.client.get_api_usage_snapshot()
        recent = snapshot["recent_calls"]
        limit = snapshot["rate_limit_per_minute"]
        percent = snapshot["usage_percent"]

        self.api_usage_progress_var.set(int(percent))
        self.api_usage_var.set(
            f"API 최근 60초 {recent}/{limit}회 ({percent:.1f}%)"
            f" | 이번 검색 {snapshot['session_calls']}회"
            f" | 누적 {snapshot['total_calls']}회"
        )
        self.root.after(1000, self._refresh_api_usage)

    def _set_status(self, message):
        self.status_var.set(f"  {message}")

    def _clear_results(self):
        for item in self.table_tree.get_children():
            self.table_tree.delete(item)
        self.detail_title_var.set("통계표를 선택하면 상세 정보가 표시됩니다.")
        self.detail_text.configure(state='normal')
        self.detail_text.delete('1.0', tk.END)
        self.detail_text.configure(state='disabled')
        self.folder_data = None
        self.all_tables = {}


# ============================================================
# 프로그램 시작
# ============================================================
if __name__ == "__main__":
    root = tk.Tk()
    app = KosisApp(root)
    root.mainloop()

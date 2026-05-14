# ============================================================
# config.example.py - Map Capture API keys
# ============================================================
# Copy this file to config.py on each PC, then replace the
# placeholder values with your own keys.
# config.py is excluded from Git via .gitignore.
# ============================================================

# NAVER Cloud Platform > Services > Maps > Application
# Use the Application authentication values.
NAVER_CLIENT_ID = ""
NAVER_CLIENT_SECRET = ""

# Static Map free quota is currently 3,000,000 calls/month for one
# representative account. Change this only if your contract differs.
NAVER_MONTHLY_LIMIT = 3_000_000

# Optional: NAVER Cloud Platform account API authentication key.
# When these are set, the app can query Cost and Usage API and show
# NAVER-side billing/usage rows in addition to the local call counter.
NCLOUD_ACCESS_KEY = ""
NCLOUD_SECRET_KEY = ""
NCLOUD_BILLING_KEYWORD = "Maps"

# Optional: NAVER Developers > Search API > Local.
# These keys are separate from NAVER Cloud Maps keys.
NAVER_LOCAL_SEARCH_CLIENT_ID = ""
NAVER_LOCAL_SEARCH_CLIENT_SECRET = ""

import Config

# DEV 환경 설정

# ─────────────────────────────────────────────────────────────────
# cycle #54 N2 → cycle #56 cancellation (Lesson #019 적용)
# ─────────────────────────────────────────────────────────────────
# 사유: 본 프로젝트는 `mix phx.server`가 아닌 `mix run --no-halt`로
#       BEAM이 시작되어 endpoint.watchers 자동 실행 메커니즘 미작동.
#
# 진단 (cycle #56 N5 검증):
#   - ps aux | grep tailwind: 0개
#   - dashboard.css mtime 변화 없음
#   - BEAM 시작: `mix run --no-halt` (mix phx.server 아님)
#
# 향후 watcher 자동화 옵션 (cycle #57+):
#   A. application.ex에 watcher child 등록 (mix run에서도 가동)
#   B. 별도 tmux: `mix tailwind default --watch &` 수동 가동
#   C. launchd로 시스템 레벨 watcher
#
# 현재: dev에서도 manual build (`mix assets.build`) 사용 가능
# ─────────────────────────────────────────────────────────────────

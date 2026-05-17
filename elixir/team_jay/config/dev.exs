import Config

# DEV 환경 설정

# cycle #54 N2: Tailwind watcher 통합
# `mix phx.server` 또는 `iex -S mix phx.server` 시작 시
# 자동으로 tailwind --watch가 백그라운드로 실행됨.
# HEEx 파일 수정 → 자동 재빌드 → LiveView가 새 CSS 로드.
config :team_jay, TeamJay.Dashboard.Endpoint,
  watchers: [
    tailwind: {Tailwind, :install_and_run, [:default, ~w(--watch)]}
    # 향후 N3에서 esbuild watcher 추가 예정
  ]

import Config

# OPS 프로덕션 환경 — 환경변수 그대로 사용하되 stdout 로그 폭주를 방지한다.
config :logger, level: :info

config :team_jay, Jay.Core.Repo,
  log: false

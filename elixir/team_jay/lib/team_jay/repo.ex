defmodule TeamJay.Repo do
  use Ecto.Repo,
    otp_app: :team_jay,
    adapter: Ecto.Adapters.Postgres
end


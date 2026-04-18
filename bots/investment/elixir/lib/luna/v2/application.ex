defmodule Luna.Application do
  @moduledoc "Luna V2 OTP 애플리케이션 (team_jay 위임 빌드용 엔트리포인트)"
  use Application

  def start(_type, _args) do
    children = []
    Supervisor.start_link(children, strategy: :one_for_one, name: Luna.ApplicationSupervisor)
  end
end

defmodule Darwin.V2.HTTP.Router do
  @moduledoc """
  다윈 V2 HTTP 라우터 (Bandit + Plug.Router).

  엔드포인트:
    GET  /darwin/health   — 헬스 체크 + 자율 레벨
    GET  /darwin/status   — ResearchMonitor KPI
    GET  /darwin/shadow   — Shadow 통계
    POST /darwin/shadow/compare — 단일 논문 즉시 비교
    GET  /darwin/rollback — 대기 중인 롤백 체크 목록
    /*   /mcp/**          — MCP Server (DARWIN_MCP_ENABLED=true 시만 라우팅)
    _    not found        — 404

  Phase 5 (현재): Bandit 직접 기동 (Darwin.V2.Supervisor에서 관리).
  Phase 6 추가: /darwin/shadow 엔드포인트.
  """

  use Plug.Router
  require Logger

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason

  plug :match
  plug :dispatch

  # ──────────────────────────────────────────────────────────────
  # 헬스 체크
  # ──────────────────────────────────────────────────────────────

  get "/darwin/health" do
    status =
      try do
        s = Darwin.V2.Lead.get_status()
        %{
          status:         :ok,
          autonomy_level: s.autonomy_level,
          kill_switch:    s.kill_switch,
          current_phase:  s.current_phase
        }
      rescue
        _ -> %{status: :ok, autonomy_level: 3}
      end

    send_resp(conn, 200, Jason.encode!(status))
  end

  # ──────────────────────────────────────────────────────────────
  # 상태 / KPI
  # ──────────────────────────────────────────────────────────────

  get "/darwin/status" do
    kpis =
      try do
        Darwin.V2.ResearchMonitor.get_kpis()
      rescue
        _ -> %{error: "research_monitor unavailable"}
      end

    send_resp(conn, 200, Jason.encode!(stringify_keys(kpis)))
  end

  # ──────────────────────────────────────────────────────────────
  # Shadow 통계
  # ──────────────────────────────────────────────────────────────

  get "/darwin/shadow" do
    summary =
      try do
        Darwin.V2.ShadowRunner.shadow_summary()
      rescue
        _ -> %{error: "shadow_runner unavailable"}
      end

    send_resp(conn, 200, Jason.encode!(stringify_keys(summary)))
  end

  # ──────────────────────────────────────────────────────────────
  # 단일 논문 Shadow 즉시 비교
  # ──────────────────────────────────────────────────────────────

  post "/darwin/shadow/compare" do
    paper = conn.body_params

    result =
      try do
        Darwin.V2.ShadowRunner.run_comparison(paper)
      rescue
        e -> %{error: Exception.message(e)}
      end

    send_resp(conn, 200, Jason.encode!(stringify_keys(result)))
  end

  # ──────────────────────────────────────────────────────────────
  # 롤백 대기 목록
  # ──────────────────────────────────────────────────────────────

  get "/darwin/rollback" do
    pending =
      try do
        Darwin.V2.RollbackScheduler.pending_checks()
        |> Enum.map(&stringify_keys/1)
      rescue
        _ -> []
      end

    send_resp(conn, 200, Jason.encode!(%{pending: pending}))
  end

  # ──────────────────────────────────────────────────────────────
  # MCP (활성화 시 forward)
  # ──────────────────────────────────────────────────────────────

  forward "/mcp", to: Darwin.V2.MCP.Server

  # ──────────────────────────────────────────────────────────────
  # 404
  # ──────────────────────────────────────────────────────────────

  match _ do
    send_resp(conn, 404, Jason.encode!(%{error: "not found"}))
  end

  # -------------------------------------------------------------------
  # Private
  # -------------------------------------------------------------------

  # 맵의 atom 키 → string 키 (JSON 직렬화 안전)
  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn
      {k, v} when is_atom(k) -> {Atom.to_string(k), stringify_val(v)}
      {k, v}                 -> {k, stringify_val(v)}
    end)
  end

  defp stringify_val(v) when is_map(v),  do: stringify_keys(v)
  defp stringify_val(v) when is_list(v), do: Enum.map(v, &stringify_val/1)
  defp stringify_val(v) when is_atom(v) and v not in [true, false, nil], do: Atom.to_string(v)
  defp stringify_val(v), do: v
end

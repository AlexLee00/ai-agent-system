defmodule Darwin.V2.MCP.Server do
  @moduledoc """
  Darwin V2 MCP 서버 — 외부 에이전트에 Darwin 도구 노출.

  Bandit + Plug.Router HTTP 엔드포인트: /mcp/darwin
  Kill Switch: DARWIN_MCP_SERVER_ENABLED (기본 false)

  노출 도구:
    "darwin.search_papers"  - 연구 DB 논문 검색
    "darwin.get_status"     - 자율 레벨 + 파이프라인 상태
    "darwin.get_insights"   - 최근 구현 논문 + 결과
    "darwin.trigger_scan"   - 논문 스캔 수동 트리거 (인증 필요)

  MCP 프로토콜: JSON-RPC 2.0 스타일
  인증: Darwin.V2.MCP.Auth (Bearer Token)
  """

  use Plug.Router
  require Logger

  @log_prefix "[다윈V2 MCP서버]"

  plug Plug.Logger, log: :debug
  plug :match
  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason
  plug :dispatch

  # ── MCP 도구 목록 ────────────────────────────────────────────────────

  @tools [
    %{
      name: "darwin.search_papers",
      description: "Darwin 연구 DB에서 논문 검색. arXiv, HN, Reddit, OpenReview 수집 논문 대상.",
      inputSchema: %{
        type: "object",
        required: ["query"],
        properties: %{
          query: %{type: "string", description: "검색 키워드 (영어 권장)"},
          limit: %{type: "integer", default: 10, description: "최대 결과 수 (1~50)"},
          source: %{type: "string", enum: ["arxiv", "hackernews", "reddit", "openreview", "all"], default: "all", description: "데이터 소스 필터"}
        }
      }
    },
    %{
      name: "darwin.get_status",
      description: "Darwin 자율 레벨 및 파이프라인 상태 조회.",
      inputSchema: %{
        type: "object",
        properties: %{}
      }
    },
    %{
      name: "darwin.get_insights",
      description: "최근 Darwin이 구현한 논문 및 결과 조회.",
      inputSchema: %{
        type: "object",
        properties: %{
          limit: %{type: "integer", default: 5, description: "조회할 최대 인사이트 수"},
          days: %{type: "integer", default: 7, description: "최근 N일 내 인사이트"}
        }
      }
    },
    %{
      name: "darwin.trigger_scan",
      description: "논문 스캔 수동 트리거 (인증 필요 — darwin.search_papers와 다름).",
      inputSchema: %{
        type: "object",
        properties: %{
          sources: %{
            type: "array",
            items: %{type: "string", enum: ["arxiv", "hackernews", "reddit", "openreview"]},
            description: "스캔할 소스 목록. 생략 시 전체 소스."
          }
        }
      }
    }
  ]

  # ── HTTP 엔드포인트 ──────────────────────────────────────────────────

  get "/mcp/darwin/health" do
    enabled = Darwin.V2.Config.mcp_server_enabled?()
    body = %{
      status: "ok",
      enabled: enabled,
      tools: length(@tools),
      autonomy_level: safe_get_autonomy_level()
    }
    json_resp(conn, 200, body)
  end

  # MCP 도구 목록 (인증 불필요 — Discovery)
  get "/mcp/darwin/tools" do
    json_resp(conn, 200, %{tools: @tools})
  end

  # MCP JSON-RPC 2.0 엔드포인트
  post "/mcp/darwin" do
    if not Darwin.V2.Config.mcp_server_enabled?() do
      json_resp(conn, 503, %{error: "MCP 서버가 비활성 상태입니다 (DARWIN_MCP_SERVER_ENABLED=false)"})
    else
      handle_jsonrpc(conn)
    end
  end

  # 레거시 호환: POST /mcp/darwin/tools/:name/call
  post "/mcp/darwin/tools/:name/call" do
    if not Darwin.V2.Config.mcp_server_enabled?() do
      json_resp(conn, 503, %{error: "MCP 서버가 비활성 상태입니다"})
    else
      conn = auth_guard(conn, name)
      if conn.halted, do: conn, else: do_tool_call(conn, name, conn.body_params || %{})
    end
  end

  # 기존 /mcp/tools/list 레거시 경로 호환
  get "/mcp/tools/list" do
    json_resp(conn, 200, %{tools: @tools})
  end

  match _ do
    json_resp(conn, 404, %{error: "not found"})
  end

  # ── JSON-RPC 처리 ────────────────────────────────────────────────────

  defp handle_jsonrpc(conn) do
    body   = conn.body_params || %{}
    id     = Map.get(body, "id")
    method = Map.get(body, "method", "")
    params = Map.get(body, "params", %{})

    result =
      case method do
        "tools/list" ->
          {:ok, %{tools: @tools}}

        "tools/call" ->
          tool_name = Map.get(params, "name", "")
          args      = Map.get(params, "arguments", %{})
          conn_auth = auth_guard(conn, tool_name)
          if conn_auth.halted do
            {:error, {401, "unauthorized"}}
          else
            call_tool(tool_name, args)
          end

        _ ->
          {:error, {-32601, "Method not found: #{method}"}}
      end

    case result do
      {:ok, data} ->
        json_resp(conn, 200, %{jsonrpc: "2.0", id: id, result: data})

      {:error, {code, message}} when is_integer(code) ->
        json_resp(conn, 200, %{
          jsonrpc: "2.0",
          id: id,
          error: %{code: code, message: message}
        })

      {:error, reason} ->
        json_resp(conn, 200, %{
          jsonrpc: "2.0",
          id: id,
          error: %{code: -32000, message: inspect(reason)}
        })
    end
  end

  # ── 도구 호출 구현 ───────────────────────────────────────────────────

  @doc false
  def list_tools, do: @tools

  @doc false
  def call_tool(name, params) do
    case name do
      "darwin.search_papers" ->
        query  = Map.get(params, "query", "")
        limit  = Map.get(params, "limit", 10)
        source = Map.get(params, "source", "all")
        search_papers(query, limit, source)

      "darwin.get_status" ->
        get_status()

      "darwin.get_insights" ->
        limit = Map.get(params, "limit", 5)
        days  = Map.get(params, "days", 7)
        get_insights(limit, days)

      "darwin.trigger_scan" ->
        sources = Map.get(params, "sources", ["arxiv", "hackernews", "reddit", "openreview"])
        trigger_scan(sources)

      _ ->
        {:error, :unknown_tool}
    end
  end

  # ── 도구 구현 상세 ───────────────────────────────────────────────────

  defp search_papers(query, _limit, _source) when not is_binary(query) or query == "" do
    {:error, {-32602, "query는 필수입니다"}}
  end

  defp search_papers(query, limit, source) do
    opts = [limit: min(limit, 50), source: source]
    case Darwin.V2.MCP.Client.search_papers(query, opts) do
      {:ok, papers} ->
        {:ok, %{papers: papers, count: length(papers), query: query}}

      {:error, :mcp_unavailable} ->
        papers = search_db_fallback(query, limit, source)
        {:ok, %{papers: papers, count: length(papers), query: query, note: "mcp_unavailable_db_fallback"}}

      {:error, reason} ->
        Logger.error("#{@log_prefix} search_papers 실패: #{inspect(reason)}")
        {:error, {-32000, "검색 실패: #{inspect(reason)}"}}
    end
  end

  defp search_db_fallback(query, limit, source) do
    source_clause = if source == "all", do: "", else: "AND source = '#{source}'"
    sql = """
    SELECT title, url, abstract, source, published_at
    FROM darwin_papers
    WHERE (title ILIKE $1 OR abstract ILIKE $1)
    #{source_clause}
    ORDER BY published_at DESC
    LIMIT $2
    """
    case Jay.Core.Repo.query(sql, ["%#{query}%", limit]) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols |> Enum.zip(row) |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)
        end)
      _ -> []
    end
  rescue
    _ -> []
  end

  defp get_status do
    autonomy      = safe_get_autonomy_level()
    kill_switches = Darwin.V2.Config.status()
    sensors       = sensor_status()

    {:ok, %{
      autonomy_level: autonomy,
      kill_switches:  kill_switches,
      sensors:        sensors,
      timestamp:      DateTime.utc_now()
    }}
  end

  defp get_insights(limit, days) do
    cutoff = DateTime.utc_now() |> DateTime.add(-days * 86_400, :second)
    sql = """
    SELECT title, source, insight_type, summary, applied_at, result_metrics
    FROM darwin_insights
    WHERE applied_at >= $1
    ORDER BY applied_at DESC
    LIMIT $2
    """
    case Jay.Core.Repo.query(sql, [cutoff, limit]) do
      {:ok, %{rows: rows, columns: cols}} ->
        insights = Enum.map(rows, fn row ->
          cols |> Enum.zip(row) |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)
        end)
        {:ok, %{insights: insights, count: length(insights), days: days}}

      {:error, reason} ->
        Logger.warning("#{@log_prefix} insights 조회 실패: #{inspect(reason)}")
        {:ok, %{insights: [], count: 0, days: days, note: "db_error"}}
    end
  rescue
    _ -> {:ok, %{insights: [], count: 0, days: days, note: "db_unavailable"}}
  end

  defp trigger_scan(sources) when is_list(sources) do
    triggered = Enum.flat_map(sources, fn source ->
      case source do
        "arxiv"       -> trigger_sensor(Darwin.V2.Sensor.ArxivRSS)
        "hackernews"  -> trigger_sensor(Darwin.V2.Sensor.HackerNews)
        "reddit"      -> trigger_sensor(Darwin.V2.Sensor.Reddit)
        "openreview"  -> trigger_sensor(Darwin.V2.Sensor.OpenReview)
        _             -> []
      end
    end)
    Logger.info("#{@log_prefix} 수동 스캔 트리거: #{inspect(triggered)}")
    {:ok, %{triggered: triggered, count: length(triggered)}}
  end

  defp trigger_sensor(module) do
    if Process.whereis(module) do
      GenServer.cast(module, :scan_now)
      [Atom.to_string(module)]
    else
      []
    end
  end

  # ── 인증 가드 ────────────────────────────────────────────────────────

  # trigger_scan은 인증 필요, 나머지 읽기 도구는 인증 선택적
  defp auth_guard(conn, "darwin.trigger_scan") do
    Darwin.V2.MCP.Auth.call(conn, [])
  end
  defp auth_guard(conn, _), do: conn

  # ── 헬퍼 ─────────────────────────────────────────────────────────────

  defp do_tool_call(conn, name, params) do
    case call_tool(name, params) do
      {:ok, result} ->
        json_resp(conn, 200, result)

      {:error, :unknown_tool} ->
        json_resp(conn, 404, %{error: "unknown tool: #{name}"})

      {:error, {code, message}} when is_integer(code) ->
        json_resp(conn, 400, %{error: message, code: code})

      {:error, reason} ->
        json_resp(conn, 500, %{error: inspect(reason)})
    end
  end

  defp safe_get_autonomy_level do
    Darwin.V2.AutonomyLevel.get().level
  rescue
    _ -> "unknown"
  end

  defp sensor_status do
    [
      {Darwin.V2.Sensor.ArxivRSS,   "arxiv"},
      {Darwin.V2.Sensor.HackerNews, "hackernews"},
      {Darwin.V2.Sensor.Reddit,     "reddit"},
      {Darwin.V2.Sensor.OpenReview, "openreview"}
    ]
    |> Enum.map(fn {mod, name} ->
      %{name: name, alive: Process.whereis(mod) != nil}
    end)
  end

  defp json_resp(conn, status, body) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end
end

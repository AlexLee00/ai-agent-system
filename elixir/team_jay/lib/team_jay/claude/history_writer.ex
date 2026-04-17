defmodule TeamJay.Claude.HistoryWriter do
  @moduledoc """
  히스토리 라이터 — 코덱스 실행 결과를 RAG에 축적

  매주 월요일 09:00 KST, 지난 주 코덱스 실행 결과 + 에러 패턴을
  pgvector RAG 테이블에 임베딩하여 저장.

  다윈팀 FeedbackLoop과 연동:
  - 코덱스 실행 결과 → RAG 저장
  - 반복 에러 패턴 → RAG 저장
  - 팀 간 이벤트 요약 → RAG 저장
  """

  use GenServer
  require Logger

  alias Jay.Core.Repo

  @check_interval_ms 3_600_000  # 1시간마다 체크
  @weekly_hour_kst   9           # 09:00 KST
  @weekly_day        1           # 월요일

  defstruct [last_write: nil]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def write_now do
    GenServer.cast(__MODULE__, :write_now)
  end

  @impl true
  def init(_opts) do
    schedule_check()
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:check, state) do
    now = DateTime.utc_now()
    kst = DateTime.add(now, 9 * 3600, :second)

    new_state =
      if should_write_weekly?(kst, state) do
        do_weekly_write(state)
      else
        state
      end

    schedule_check()
    {:noreply, new_state}
  end

  @impl true
  def handle_cast(:write_now, state) do
    {:noreply, do_weekly_write(state)}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp schedule_check do
    Process.send_after(self(), :check, @check_interval_ms)
  end

  defp should_write_weekly?(kst_now, state) do
    day_match = Date.day_of_week(DateTime.to_date(kst_now)) == @weekly_day
    hour_match = kst_now.hour == @weekly_hour_kst

    already_done =
      case state.last_write do
        nil -> false
        last ->
          Date.diff(DateTime.to_date(kst_now), DateTime.to_date(last)) < 6
      end

    day_match and hour_match and not already_done
  end

  defp do_weekly_write(state) do
    Logger.info("[HistoryWriter] 주간 히스토리 RAG 저장 시작")

    with {:ok, codex_summary} <- collect_codex_history(),
         {:ok, error_summary} <- collect_error_patterns(),
         :ok <- write_to_rag(codex_summary, "codex_history"),
         :ok <- write_to_rag(error_summary, "error_patterns") do
      Logger.info("[HistoryWriter] RAG 저장 완료")
      %{state | last_write: DateTime.utc_now()}
    else
      {:error, reason} ->
        Logger.warning("[HistoryWriter] RAG 저장 실패: #{inspect(reason)}")
        state
    end
  end

  defp collect_codex_history do
    week_ago = DateTime.add(DateTime.utc_now(), -7 * 24 * 3600, :second)

    case Repo.query("""
      SELECT codex_name, status, deployed_at, notes
      FROM claude.deployment_monitor
      WHERE deployed_at >= $1
      ORDER BY deployed_at DESC
    """, [week_ago]) do
      {:ok, %{rows: rows, columns: cols}} ->
        summary =
          rows
          |> Enum.map(fn row -> Enum.zip(cols, row) |> Map.new() end)
          |> Enum.map(fn r ->
            "코덱스: #{r["codex_name"]} | 상태: #{r["status"]} | 배포: #{r["deployed_at"]}"
          end)
          |> Enum.join("\n")
        {:ok, "## 주간 코덱스 실행 이력\n#{summary}"}
      {:error, reason} ->
        {:error, reason}
    end
  end

  defp collect_error_patterns do
    week_ago = DateTime.add(DateTime.utc_now(), -7 * 24 * 3600, :second)

    case Repo.query("""
      SELECT event_type, bot_name, COUNT(*) as cnt
      FROM agent.event_lake
      WHERE team = 'claude'
        AND severity IN ('error', 'warn')
        AND inserted_at >= $1
      GROUP BY event_type, bot_name
      ORDER BY cnt DESC
      LIMIT 20
    """, [week_ago]) do
      {:ok, %{rows: rows}} ->
        summary =
          rows
          |> Enum.map(fn [type, bot, cnt] -> "#{type} (#{bot}): #{cnt}건" end)
          |> Enum.join("\n")
        {:ok, "## 주간 에러 패턴\n#{summary}"}
      {:error, reason} ->
        {:error, reason}
    end
  end

  defp write_to_rag(content, tag) do
    # Hub RAG API 호출 (packages/core/lib/rag.js와 동일한 엔드포인트)
    hub_url = Jay.Core.Config.hub_url()
    hub_token = Jay.Core.Config.hub_token()

    if is_nil(hub_url) or is_nil(hub_token) do
      Logger.warning("[HistoryWriter] Hub URL/Token 없음, RAG 저장 건너뜀")
      :ok
    else
      body = Jason.encode!(%{
        content: content,
        team: "claude",
        tag: tag,
        source: "history_writer"
      })

      case :httpc.request(:post,
             {~c"#{hub_url}/api/rag/store",
              [{~c"authorization", ~c"Bearer #{hub_token}"}],
              ~c"application/json",
              body},
             [{:timeout, 30_000}], []) do
        {:ok, {{_, 200, _}, _, _}} -> :ok
        {:ok, {{_, code, _}, _, resp}} ->
          Logger.warning("[HistoryWriter] RAG 저장 응답 #{code}: #{resp}")
          :ok  # 비치명적 실패
        {:error, reason} ->
          {:error, reason}
      end
    end
  end
end

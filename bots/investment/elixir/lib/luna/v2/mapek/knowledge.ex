defmodule Luna.V2.MAPEK.Knowledge do
  @moduledoc """
  MAPE-K Knowledge — 투자 패턴 학습 저장소.

  역할:
    - 거래 결과 → 패턴 추출 (레짐/신호/결과 삼중 연결)
    - 리스크 위반 이력 → 규칙 강화 기여
    - Commander에게 유사 상황 검색 (Agentic RAG 준비)

  저장 대상: investment.mapek_knowledge (event_type, payload, created_at)
  """

  use GenServer
  require Logger

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ─── 공개 API ───────────────────────────────────────────────────────

  @doc "거래 결과 Knowledge 저장"
  def record_outcome(symbol, signal, outcome, meta \\ %{}) do
    payload = Map.merge(%{symbol: symbol, signal: signal, outcome: outcome}, meta)
    GenServer.cast(__MODULE__, {:record, "signal_outcome", payload})
  end

  @doc "리스크 위반 Knowledge 저장"
  def record_violation(violation_type, details) do
    GenServer.cast(__MODULE__, {:record, "risk_violation", %{type: violation_type, details: details}})
  end

  @doc "최근 N개 Knowledge 조회"
  def recent(event_type \\ nil, limit \\ 20) do
    GenServer.call(__MODULE__, {:recent, event_type, limit}, 10_000)
  end

  # ─── GenServer 콜백 ─────────────────────────────────────────────────

  def init(_opts) do
    Logger.info("[루나V2/MAPE-K Knowledge] Knowledge 저장소 준비")
    {:ok, %{}}
  end

  def handle_cast({:record, event_type, payload}, state) do
    save_async(event_type, payload)
    {:noreply, state}
  end

  def handle_call({:recent, event_type, limit}, _from, state) do
    result = fetch_recent(event_type, limit)
    {:reply, result, state}
  end

  # ─── DB 접근 ────────────────────────────────────────────────────────

  defp save_async(event_type, payload) do
    Task.start(fn ->
      query = """
      INSERT INTO investment.mapek_knowledge
        (event_type, payload, created_at)
      VALUES ($1, $2, NOW())
      """
      case Jay.Core.Repo.query(query, [event_type, Jason.encode!(payload)]) do
        {:ok, _}         -> :ok
        {:error, reason} -> Logger.warning("[루나V2/Knowledge] 저장 실패: #{inspect(reason)}")
      end
    end)
  end

  defp fetch_recent(nil, limit) do
    query = """
    SELECT id, event_type, payload, created_at
    FROM investment.mapek_knowledge
    ORDER BY created_at DESC
    LIMIT $1
    """
    case Jay.Core.Repo.query(query, [limit]) do
      {:ok, %{rows: rows}} -> {:ok, format_rows(rows)}
      {:error, r}          -> {:error, inspect(r)}
    end
  end

  defp fetch_recent(event_type, limit) do
    query = """
    SELECT id, event_type, payload, created_at
    FROM investment.mapek_knowledge
    WHERE event_type = $1
    ORDER BY created_at DESC
    LIMIT $2
    """
    case Jay.Core.Repo.query(query, [event_type, limit]) do
      {:ok, %{rows: rows}} -> {:ok, format_rows(rows)}
      {:error, r}          -> {:error, inspect(r)}
    end
  end

  defp format_rows(rows) do
    Enum.map(rows, fn [id, et, payload_str, ts] ->
      %{id: id, event_type: et, payload: Jason.decode!(payload_str || "{}"), created_at: ts}
    end)
  end
end

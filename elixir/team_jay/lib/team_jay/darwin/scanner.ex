defmodule TeamJay.Darwin.Scanner do
  @moduledoc """
  다윈팀 스캐너 — 논문 수집 결과 처리 + JayBus 브로드캐스트

  research-scanner.ts (PortAgent)가 arXiv/HuggingFace 수집 후 rag_research 테이블 저장.
  이 GenServer는:
  1. 6시간마다 rag_research에서 신규 논문 폴링
  2. 발견된 논문 → TeamLead.paper_discovered() + JayBus 브로드캐스트
  3. trigger_scan/0 — PortAgent darwin_scanner를 즉시 실행
  """

  use GenServer
  require Logger

  alias TeamJay.Repo
  alias TeamJay.Darwin.{TeamLead, Topics}
  alias TeamJay.Agents.PortAgent

  @poll_interval_ms 6 * 3_600_000   # 6시간마다 신규 논문 체크

  defstruct [last_poll_at: nil, total_discovered: 0]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 스캔 트리거 (darwin_scanner PortAgent 실행)"
  def trigger_scan do
    GenServer.cast(__MODULE__, :trigger_scan)
  end

  @doc "신규 논문 폴링 즉시 실행"
  def poll_now do
    GenServer.cast(__MODULE__, :poll_now)
  end

  @impl true
  def init(_opts) do
    schedule_poll()
    Logger.info("[DarwinScanner] 스캐너 시작! #{@poll_interval_ms / 3_600_000}시간 주기 폴링")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info(:poll, state) do
    new_state = do_poll(state)
    schedule_poll()
    {:noreply, new_state}
  end

  @impl true
  def handle_cast(:trigger_scan, state) do
    Logger.info("[DarwinScanner] 즉시 스캔 트리거!")
    PortAgent.run(:darwin_scanner)
    {:noreply, state}
  end

  def handle_cast(:poll_now, state) do
    {:noreply, do_poll(state)}
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp schedule_poll do
    Process.send_after(self(), :poll, @poll_interval_ms)
  end

  defp do_poll(state) do
    since = state.last_poll_at || DateTime.add(DateTime.utc_now(), -24 * 3600, :second)

    papers = fetch_new_papers(since)

    if length(papers) > 0 do
      Logger.info("[DarwinScanner] 신규 논문 #{length(papers)}건 발견")
      Enum.each(papers, fn paper ->
        TeamLead.paper_discovered(paper)
        broadcast_paper_discovered(paper)
      end)
    else
      Logger.debug("[DarwinScanner] 신규 논문 없음")
    end

    %{state |
      last_poll_at: DateTime.utc_now(),
      total_discovered: state.total_discovered + length(papers)
    }
  end

  defp fetch_new_papers(since) do
    since_str = DateTime.to_naive(since) |> NaiveDateTime.to_string()

    case Repo.query("""
      SELECT title, url, score, summary, source, tags, published_at, created_at
      FROM rag_research
      WHERE created_at > $1
        AND score IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 50
    """, [since_str]) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols
          |> Enum.zip(row)
          |> Map.new()
        end)
      {:error, reason} ->
        Logger.warning("[DarwinScanner] DB 쿼리 실패: #{inspect(reason)}")
        []
    end
  end

  defp broadcast_paper_discovered(paper) do
    Registry.dispatch(TeamJay.JayBus, Topics.paper_discovered(), fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_event, Topics.paper_discovered(), %{paper: paper}})
      end
    end)
  end
end

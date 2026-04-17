defmodule Darwin.V2.Scanner do
  @moduledoc """
  다윈 V2 스캐너 — 논문 수집 + JayBus/PubSub 브로드캐스트.

  TeamJay.Darwin.Scanner에서 진화:
    - V2 센서(arxiv_rss, hackernews, reddit, openreview) PubSub 집계
    - reservation.rag_research DB 6시간 폴링 (하위 호환)
    - URL 기반 중복 제거 (arXiv ID 정규화)
    - 발견 논문 → Lead.paper_discovered/1 + JayBus/PubSub 브로드캐스트
  """

  use GenServer
  require Logger

  alias Darwin.V2.{Topics, Lead}
  alias TeamJay.HubClient

  @poll_interval_ms 6 * 3_600_000  # 6시간마다 DB 폴링
  @dedup_table :darwin_v2_scanner_dedup

  defstruct [
    last_poll_at: nil,
    total_discovered: 0,
    seen_urls: MapSet.new()
  ]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 스캔 트리거 (수동)"
  def trigger_scan do
    GenServer.cast(__MODULE__, :trigger_scan)
  end

  @doc "DB 폴링 즉시 실행"
  def poll_now do
    GenServer.cast(__MODULE__, :poll_now)
  end

  @impl GenServer
  def init(_opts) do
    # ETS dedup 테이블
    :ets.new(@dedup_table, [:named_table, :set, :public])

    # JayBus 구독 (V2 센서가 방출하는 paper_discovered 이벤트)
    Process.send_after(self(), :subscribe_events, 2_000)

    # 6시간 폴링 스케줄
    schedule_poll()

    Logger.info("[다윈V2 스캐너] 시작! DB 폴링 #{@poll_interval_ms / 3_600_000}시간 주기")
    {:ok, %__MODULE__{}}
  end

  # ── 이벤트 처리 ──────────────────────────────────────────────────────

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    # V2 센서들(arxiv_rss, hackernews, reddit, openreview)이 방출하는 토픽 구독
    Registry.register(TeamJay.JayBus, Topics.paper_discovered(), [])
    # 센서별 원시 시그널 토픽도 구독
    Registry.register(TeamJay.JayBus, "darwin.sensor.arxiv", [])
    Registry.register(TeamJay.JayBus, "darwin.sensor.hackernews", [])
    Registry.register(TeamJay.JayBus, "darwin.sensor.reddit", [])
    Registry.register(TeamJay.JayBus, "darwin.sensor.openreview", [])
    Logger.debug("[다윈V2 스캐너] JayBus 구독 완료 (센서 4종)")
    {:noreply, state}
  end

  def handle_info(:poll, state) do
    new_state = do_db_poll(state)
    schedule_poll()
    {:noreply, new_state}
  end

  # 센서 원시 시그널 → 중복 확인 후 처리
  def handle_info({:jay_event, topic, payload}, state)
      when topic in [
        "darwin.sensor.arxiv",
        "darwin.sensor.hackernews",
        "darwin.sensor.reddit",
        "darwin.sensor.openreview"
      ] do
    papers = extract_papers_from_sensor(payload, topic)
    new_state = process_papers(papers, state)
    {:noreply, new_state}
  end

  # 다른 에이전트가 이미 처리한 paper_discovered — 중복 카운트 방지를 위해 무시
  def handle_info({:jay_event, "darwin.paper.discovered", _payload}, state) do
    {:noreply, state}
  end

  def handle_info({:jay_event, _topic, _payload}, state), do: {:noreply, state}
  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast(:trigger_scan, state) do
    Logger.info("[다윈V2 스캐너] 즉시 스캔 트리거!")
    # 모든 센서에 스캔 요청 브로드캐스트
    broadcast_internal("darwin.scanner.trigger", %{triggered_at: DateTime.utc_now()})
    {:noreply, state}
  end

  def handle_cast(:poll_now, state) do
    {:noreply, do_db_poll(state)}
  end

  # ── 내부 ─────────────────────────────────────────────────────────────

  defp schedule_poll do
    Process.send_after(self(), :poll, @poll_interval_ms)
  end

  defp do_db_poll(state) do
    since = state.last_poll_at || DateTime.add(DateTime.utc_now(), -24 * 3600, :second)
    since_str = DateTime.to_naive(since) |> NaiveDateTime.to_string()

    papers = fetch_new_papers_from_db(since_str)

    if length(papers) > 0 do
      Logger.info("[다윈V2 스캐너] DB 폴링 신규 논문 #{length(papers)}건")
    end

    new_state = process_papers(papers, %{state | last_poll_at: DateTime.utc_now()})
    new_state
  end

  defp fetch_new_papers_from_db(since_str) do
    sql = """
    SELECT id, title, url, score, summary, source, tags, published_at, created_at
    FROM reservation.rag_research
    WHERE created_at > $1
      AND score IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
    """

    case Ecto.Adapters.SQL.query(TeamJay.Repo, sql, [since_str]) do
      {:ok, %{rows: rows, columns: cols}} ->
        Enum.map(rows, fn row ->
          cols |> Enum.zip(row) |> Map.new()
        end)

      {:error, reason} ->
        Logger.warning("[다윈V2 스캐너] DB 폴링 실패: #{inspect(reason)}")
        []
    end
  rescue
    e ->
      Logger.warning("[다윈V2 스캐너] DB 폴링 예외: #{inspect(e)}")
      []
  end

  defp process_papers(papers, state) do
    {new_papers, new_seen} =
      Enum.reduce(papers, {[], state.seen_urls}, fn paper, {acc, seen} ->
        url = normalize_url(paper["url"] || paper[:url] || "")

        if url == "" or MapSet.member?(seen, url) do
          {acc, seen}
        else
          {[paper | acc], MapSet.put(seen, url)}
        end
      end)

    if length(new_papers) > 0 do
      Logger.info("[다윈V2 스캐너] 신규 논문 #{length(new_papers)}건 처리")

      Enum.each(new_papers, fn paper ->
        Lead.paper_discovered(paper)
        broadcast_paper_discovered(paper)
      end)
    end

    %{state |
      total_discovered: state.total_discovered + length(new_papers),
      seen_urls: new_seen
    }
  end

  defp extract_papers_from_sensor(payload, topic) do
    source =
      case topic do
        "darwin.sensor.arxiv"       -> "arxiv_rss"
        "darwin.sensor.hackernews"  -> "hackernews"
        "darwin.sensor.reddit"      -> "reddit"
        "darwin.sensor.openreview"  -> "openreview"
        _                           -> "unknown"
      end

    papers = payload[:papers] || payload["papers"] || [payload]

    Enum.map(papers, fn p ->
      Map.merge(%{"source" => source}, stringify_keys(p))
    end)
  end

  defp broadcast_paper_discovered(paper) do
    topic = Topics.paper_discovered()
    payload = %{paper: paper}

    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)

    Phoenix.PubSub.broadcast(Darwin.V2.PubSub, topic, payload)
  end

  defp broadcast_internal(topic, payload) do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, payload})
    end)
  end

  # arXiv URL 정규화: abs/2501.12345 → 2501.12345
  defp normalize_url(url) when is_binary(url) do
    case Regex.run(~r/arxiv\.org\/(?:abs|pdf)\/([0-9]+\.[0-9]+)/, url) do
      [_, id] -> "arxiv:#{id}"
      _       -> url
    end
  end
  defp normalize_url(_), do: ""

  defp stringify_keys(map) when is_map(map) do
    Map.new(map, fn {k, v} -> {to_string(k), v} end)
  end
  defp stringify_keys(other), do: other
end

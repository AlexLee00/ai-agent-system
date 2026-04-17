defmodule Darwin.V2.Sensor.HackerNews do
  @moduledoc """
  Hacker News 센서 — 2시간 주기로 AI/ML 논문 관련 HN 스토리 수집.

  Algolia HN API 2개 쿼리:
    - "paper AI machine learning"
    - "arxiv"
  필터: points >= 50 OR num_comments >= 20
  ETS 중복 제거 (7일).
  Kill Switch: DARWIN_SENSOR_HN_ENABLED (기본 true)
  """

  use GenServer
  require Logger

  @poll_interval_ms 2 * 60 * 60 * 1_000
  @dedup_ttl_ms 7 * 24 * 60 * 60 * 1_000
  @min_points 50
  @min_comments 20
  @log_prefix "[다윈V2 센서:HN]"

  @queries [
    "paper+AI+machine+learning",
    "arxiv"
  ]

  @algolia_base "https://hn.algolia.com/api/v1/search"

  # Public API

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 스캔 트리거."
  def scan_now do
    GenServer.cast(__MODULE__, :scan_now)
  end

  @doc "ETS 캐시 크기."
  def dedup_cache_size do
    GenServer.call(__MODULE__, :dedup_cache_size)
  end

  # GenServer callbacks

  @impl GenServer
  def init(_opts) do
    table = :ets.new(:darwin_hn_dedup, [:set, :private])
    if enabled?() do
      schedule_poll(0)
      Logger.info("#{@log_prefix} 시작 (쿼리: #{Enum.join(@queries, ", ")})")
    else
      Logger.info("#{@log_prefix} 비활성 (DARWIN_SENSOR_HN_ENABLED != true)")
    end
    {:ok, %{table: table, emitted: 0}}
  end

  @impl GenServer
  def handle_cast(:scan_now, state) do
    {:noreply, do_scan(state)}
  end

  @impl GenServer
  def handle_call(:dedup_cache_size, _from, state) do
    {:reply, :ets.info(state.table, :size), state}
  end

  @impl GenServer
  def handle_info(:poll, state) do
    new_state = if enabled?(), do: do_scan(state), else: state
    schedule_poll(@poll_interval_ms)
    {:noreply, new_state}
  end

  # Private

  defp do_scan(state) do
    expire_old_entries(state.table)
    emitted = Enum.reduce(@queries, 0, fn query, acc ->
      acc + scan_query(query, state.table)
    end)
    Logger.info("#{@log_prefix} 스캔 완료 — 신규 #{emitted}건 발행")
    %{state | emitted: state.emitted + emitted}
  end

  defp scan_query(query, table) do
    url = "#{@algolia_base}?query=#{query}&tags=story&hitsPerPage=20"
    case Req.get(url, receive_timeout: 15_000) do
      {:ok, %{status: 200, body: body}} ->
        hits = Map.get(body, "hits", [])
        hits
        |> Enum.filter(&quality_filter?/1)
        |> Enum.reduce(0, fn hit, acc ->
          story_id = to_string(Map.get(hit, "objectID", ""))
          if already_seen?(table, story_id) or story_id == "" do
            acc
          else
            mark_seen(table, story_id)
            emit_papers_from_hit(hit)
            acc + 1
          end
        end)

      {:ok, %{status: status}} ->
        Logger.warning("#{@log_prefix} 쿼리 '#{query}' HTTP #{status}")
        0

      {:error, reason} ->
        Logger.error("#{@log_prefix} 쿼리 '#{query}' 요청 실패: #{inspect(reason)}")
        0
    end
  end

  defp quality_filter?(hit) do
    points = Map.get(hit, "points", 0) || 0
    comments = Map.get(hit, "num_comments", 0) || 0
    points >= @min_points or comments >= @min_comments
  end

  defp emit_papers_from_hit(hit) do
    title    = Map.get(hit, "title", "")
    url      = Map.get(hit, "url", "") || ""
    story_text = Map.get(hit, "story_text", "") || ""
    points   = Map.get(hit, "points", 0) || 0
    comments = Map.get(hit, "num_comments", 0) || 0
    created_at = parse_created_at(Map.get(hit, "created_at"))

    # story URL이 arxiv면 직접 발행
    arxiv_urls = extract_arxiv_urls(url <> " " <> story_text)

    if Enum.empty?(arxiv_urls) and url != "" do
      # arxiv 링크가 없어도 일반 논문 링크로 발행 (title 기반 필터)
      if looks_like_paper?(title) do
        paper = %{
          title: title,
          url: url,
          abstract: strip_html(story_text),
          source: "hackernews",
          published_at: created_at,
          community_score: %{upvotes: points, comment_count: comments}
        }
        emit(paper)
      end
    else
      Enum.each(arxiv_urls, fn arxiv_url ->
        paper = %{
          title: title,
          url: arxiv_url,
          abstract: strip_html(story_text),
          source: "hackernews",
          published_at: created_at,
          community_score: %{upvotes: points, comment_count: comments}
        }
        emit(paper)
      end)
    end
  end

  defp extract_arxiv_urls(text) do
    Regex.scan(~r/https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/\d{4}\.\d{4,5}(?:v\d+)?/i, text)
    |> Enum.map(fn [url] -> url end)
    |> Enum.uniq()
  end

  defp looks_like_paper?(title) do
    lower = String.downcase(title)
    String.contains?(lower, ["paper", "arxiv", "neural", "model", "learning", "llm", "gpt", "transformer"])
  end

  defp strip_html(nil), do: ""
  defp strip_html(text), do: Regex.replace(~r/<[^>]+>/, text, "") |> String.trim()

  defp parse_created_at(nil), do: DateTime.utc_now()
  defp parse_created_at(str) do
    case DateTime.from_iso8601(str) do
      {:ok, dt, _} -> dt
      _ -> DateTime.utc_now()
    end
  end

  defp already_seen?(table, id) do
    case :ets.lookup(table, id) do
      [{^id, _ts}] -> true
      _ -> false
    end
  end

  defp mark_seen(table, id) do
    :ets.insert(table, {id, System.monotonic_time(:millisecond)})
  end

  defp expire_old_entries(table) do
    now = System.monotonic_time(:millisecond)
    cutoff = now - @dedup_ttl_ms
    :ets.select_delete(table, [{{:_, :"$1"}, [{:<, :"$1", cutoff}], [true]}])
  end

  defp emit(paper) do
    topic = Darwin.V2.Topics.paper_discovered()
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, paper})
    end)
  end

  defp schedule_poll(delay_ms) do
    Process.send_after(self(), :poll, delay_ms)
  end

  defp enabled? do
    System.get_env("DARWIN_SENSOR_HN_ENABLED", "true") == "true"
  end
end

defmodule Darwin.V2.Sensor.Reddit do
  @moduledoc """
  Reddit 센서 — 1시간 주기로 AI/ML 커뮤니티 논문 링크 수집.

  구독 서브레딧: r/MachineLearning, r/artificial, r/LocalLLaMA, r/deeplearning
  URL: https://www.reddit.com/r/{subreddit}/hot.json?limit=25
  필터: score >= 100
  Rate limit: 2 req/sec (Process.sleep 적용)
  User-Agent: "darwin-research-bot/2.0 (team-jay)"
  ETS 중복 제거 (7일).
  Kill Switch: DARWIN_SENSOR_REDDIT_ENABLED (기본 true)
  """

  use GenServer
  require Logger

  @poll_interval_ms 60 * 60 * 1_000
  @dedup_ttl_ms 7 * 24 * 60 * 60 * 1_000
  @min_score 100
  @rate_limit_ms 500  # 2 req/sec → 500ms 간격
  @log_prefix "[다윈V2 센서:Reddit]"
  @user_agent "darwin-research-bot/2.0 (team-jay)"

  @subreddits [
    "MachineLearning",
    "artificial",
    "LocalLLaMA",
    "deeplearning"
  ]

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
    table = :ets.new(:darwin_reddit_dedup, [:set, :private])
    if enabled?() do
      schedule_poll(0)
      Logger.info("#{@log_prefix} 시작 (서브레딧: #{Enum.join(@subreddits, ", ")})")
    else
      Logger.info("#{@log_prefix} 비활성 (DARWIN_SENSOR_REDDIT_ENABLED != true)")
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
    emitted =
      @subreddits
      |> Enum.with_index()
      |> Enum.reduce(0, fn {subreddit, idx}, acc ->
        # 첫 번째 외에는 rate limit 간격 적용
        if idx > 0, do: Process.sleep(@rate_limit_ms)
        acc + scan_subreddit(subreddit, state.table)
      end)
    Logger.info("#{@log_prefix} 스캔 완료 — 신규 #{emitted}건 발행")
    %{state | emitted: state.emitted + emitted}
  end

  defp scan_subreddit(subreddit, table) do
    url = "https://www.reddit.com/r/#{subreddit}/hot.json?limit=25"
    headers = [{"User-Agent", @user_agent}]

    case Req.get(url, headers: headers, receive_timeout: 15_000) do
      {:ok, %{status: 200, body: body}} ->
        posts = get_in(body, ["data", "children"]) || []
        posts
        |> Enum.filter(fn %{"data" => data} ->
          score = Map.get(data, "score", 0) || 0
          score >= @min_score
        end)
        |> Enum.reduce(0, fn %{"data" => data}, acc ->
          post_id = Map.get(data, "id", "")
          if already_seen?(table, post_id) or post_id == "" do
            acc
          else
            mark_seen(table, post_id)
            emitted = emit_papers_from_post(data, subreddit)
            acc + emitted
          end
        end)

      {:ok, %{status: 429}} ->
        Logger.warning("#{@log_prefix} r/#{subreddit} 속도 제한 (429) — 건너뜀")
        0

      {:ok, %{status: status}} ->
        Logger.warning("#{@log_prefix} r/#{subreddit} HTTP #{status}")
        0

      {:error, reason} ->
        Logger.error("#{@log_prefix} r/#{subreddit} 요청 실패: #{inspect(reason)}")
        0
    end
  end

  defp emit_papers_from_post(data, subreddit) do
    title    = Map.get(data, "title", "")
    url      = Map.get(data, "url", "") || ""
    selftext = Map.get(data, "selftext", "") || ""
    score    = Map.get(data, "score", 0) || 0
    num_comments = Map.get(data, "num_comments", 0) || 0
    created_utc = Map.get(data, "created_utc", nil)
    published_at = unix_to_datetime(created_utc)

    community_score = %{upvotes: score, comment_count: num_comments}

    # post URL + selftext에서 arxiv 링크 추출
    arxiv_urls = extract_arxiv_urls(url <> " " <> selftext)

    cond do
      Enum.any?(arxiv_urls) ->
        Enum.each(arxiv_urls, fn arxiv_url ->
          paper = %{
            title: title,
            url: arxiv_url,
            abstract: String.slice(selftext, 0, 500),
            source: "reddit",
            published_at: published_at,
            community_score: community_score,
            metadata: %{subreddit: subreddit}
          }
          emit(paper)
        end)
        length(arxiv_urls)

      looks_like_paper_link?(url) ->
        paper = %{
          title: title,
          url: url,
          abstract: String.slice(selftext, 0, 500),
          source: "reddit",
          published_at: published_at,
          community_score: community_score,
          metadata: %{subreddit: subreddit}
        }
        emit(paper)
        1

      true ->
        0
    end
  end

  defp extract_arxiv_urls(text) do
    Regex.scan(~r/https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/\d{4}\.\d{4,5}(?:v\d+)?/i, text)
    |> Enum.map(fn [url] -> url end)
    |> Enum.uniq()
  end

  defp looks_like_paper_link?(url) do
    lower = String.downcase(url)
    String.contains?(lower, ["arxiv.org", "openreview.net", "papers.nips.cc",
                              "proceedings.mlr.press", "aclanthology.org",
                              "dl.acm.org/doi", "ieeexplore.ieee.org"])
  end

  defp unix_to_datetime(nil), do: DateTime.utc_now()
  defp unix_to_datetime(ts) when is_number(ts) do
    ts_int = trunc(ts)
    case DateTime.from_unix(ts_int) do
      {:ok, dt} -> dt
      _ -> DateTime.utc_now()
    end
  end
  defp unix_to_datetime(_), do: DateTime.utc_now()

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
    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, paper})
    end)
  end

  defp schedule_poll(delay_ms) do
    Process.send_after(self(), :poll, delay_ms)
  end

  defp enabled? do
    System.get_env("DARWIN_SENSOR_REDDIT_ENABLED", "true") == "true"
  end
end

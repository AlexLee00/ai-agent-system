defmodule Darwin.V2.Sensor.SemanticScholar do
  @moduledoc """
  Semantic Scholar 센서 — 6시간 주기로 인용 그래프 기반 AI/ML 논문 수집.

  API: https://api.semanticscholar.org/graph/v1/
  쿼리: 9 도메인별 최신 AI/ML 논문 검색
  필터: citationCount >= 5 또는 최신 1년 이내
  ETS 중복 제거 (7일).
  Kill Switch: DARWIN_SENSOR_SEMANTIC_SCHOLAR_ENABLED (기본 true)
  선택적 API 키: SEMANTIC_SCHOLAR_API_KEY (없어도 동작, rate limit 완화)
  """

  use GenServer
  require Logger

  @poll_interval_ms 6 * 60 * 60 * 1_000
  @dedup_ttl_ms 7 * 24 * 60 * 60 * 1_000
  @api_base "https://api.semanticscholar.org/graph/v1"
  @results_limit 100
  @min_citations 5
  @log_prefix "[다윈V2 센서:SemanticScholar]"

  @fields "title,abstract,url,year,citationCount,publicationDate,externalIds"

  # 9 도메인 대표 쿼리 (darwin 9 domains)
  @domain_queries [
    "large language models agents autonomous",
    "reinforcement learning reward optimization",
    "computer vision multimodal generation",
    "graph neural networks knowledge representation",
    "neural architecture search automated machine learning",
    "time series forecasting financial prediction",
    "code generation software engineering automation",
    "retrieval augmented generation knowledge base",
    "multi-agent systems collaborative AI"
  ]

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

  @impl GenServer
  def init(_opts) do
    table = :ets.new(:darwin_semantic_scholar_dedup, [:set, :private])
    if enabled?() do
      schedule_poll(0)
      Logger.info("#{@log_prefix} 시작 (Semantic Scholar API, #{length(@domain_queries)} 도메인 쿼리)")
    else
      Logger.info("#{@log_prefix} 비활성 (DARWIN_SENSOR_SEMANTIC_SCHOLAR_ENABLED != true)")
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
    emitted = Enum.reduce_while(@domain_queries, 0, fn query, acc ->
      Process.sleep(1_000)

      case scan_query(query, state.table) do
        {:ok, count} -> {:cont, acc + count}
        :rate_limited -> {:halt, acc}
      end
    end)

    Logger.info("#{@log_prefix} 스캔 완료 — 신규 #{emitted}건 발행")
    %{state | emitted: state.emitted + emitted}
  end

  defp scan_query(query, table) do
    url = "#{@api_base}/paper/search"
    params = [
      query: query,
      fields: @fields,
      limit: @results_limit,
      sort: "citationCount"
    ]

    headers = build_headers()

    case Req.get(url,
           params: params,
           headers: headers,
           receive_timeout: 20_000
         ) do
      {:ok, %{status: 200, body: body}} ->
        papers = Map.get(body, "data", []) || []
        Enum.reduce(papers, 0, fn paper, nacc ->
          paper_id = Map.get(paper, "paperId", "") |> to_string()
          if already_seen?(table, paper_id) or paper_id == "" do
            nacc
          else
            mark_seen(table, paper_id)
            nacc + maybe_emit_paper(paper)
          end
        end)
        |> then(&{:ok, &1})

      {:ok, %{status: 429}} ->
        # Rate limit: API 키 없이 초과 시 같은 scan에서 남은 쿼리도 대부분 실패한다.
        Logger.warning("#{@log_prefix} Rate limit (429) — 쿼리 '#{String.slice(query, 0, 40)}' 이후 남은 쿼리 건너뜀")
        :rate_limited

      {:ok, %{status: status}} ->
        Logger.warning("#{@log_prefix} HTTP #{status} 쿼리='#{String.slice(query, 0, 40)}'")
        {:ok, 0}

      {:error, reason} ->
        Logger.error("#{@log_prefix} 요청 실패: #{inspect(reason)}")
        {:ok, 0}
    end
  end

  defp maybe_emit_paper(paper) do
    title      = Map.get(paper, "title", "") || ""
    abstract   = Map.get(paper, "abstract", "") || ""
    citations  = Map.get(paper, "citationCount", 0) || 0
    year       = Map.get(paper, "year", 0) || 0
    pub_date   = Map.get(paper, "publicationDate", "")
    ext_ids    = Map.get(paper, "externalIds", %{}) || %{}
    s2_url     = Map.get(paper, "url", "")

    # 필터: 최신(2024+) 또는 인용 >= @min_citations
    current_year = Date.utc_today().year
    is_recent = year >= current_year - 1
    is_cited  = citations >= @min_citations

    if (is_recent or is_cited) and title != "" do
      # arXiv ID 우선, 없으면 S2 URL
      url =
        case Map.get(ext_ids, "ArXiv") do
          arxiv_id when is_binary(arxiv_id) and arxiv_id != "" ->
            "https://arxiv.org/abs/#{arxiv_id}"
          _ ->
            s2_url || "https://www.semanticscholar.org/paper/#{Map.get(paper, "paperId", "")}"
        end

      published_at =
        if pub_date && pub_date != "" do
          case Date.from_iso8601(pub_date) do
            {:ok, d} -> DateTime.new!(d, ~T[00:00:00], "Etc/UTC")
            _ -> DateTime.utc_now()
          end
        else
          DateTime.utc_now()
        end

      emit(%{
        title: title,
        url: url,
        abstract: String.slice(abstract, 0, 1000),
        source: "semantic_scholar",
        published_at: published_at,
        metadata: %{
          citations: citations,
          year: year,
          paper_id: Map.get(paper, "paperId", ""),
          arxiv_id: Map.get(ext_ids, "ArXiv", "")
        }
      })
      1
    else
      0
    end
  end

  defp build_headers do
    base = [{"User-Agent", "darwin-research-bot/2.0"}]
    case System.get_env("SEMANTIC_SCHOLAR_API_KEY") do
      key when is_binary(key) and key != "" -> [{"x-api-key", key} | base]
      _ -> base
    end
  end

  defp emit(paper) do
    topic = Darwin.V2.Topics.paper_discovered()
    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, paper})
    end)
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

  defp schedule_poll(delay_ms) do
    Process.send_after(self(), :poll, delay_ms)
  end

  defp enabled? do
    System.get_env("DARWIN_SENSOR_SEMANTIC_SCHOLAR_ENABLED", "true") == "true"
  end
end

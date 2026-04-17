defmodule Darwin.V2.Sensor.ArxivRSS do
  @moduledoc """
  arXiv RSS 센서 — 30분 주기로 AI/ML 논문을 수집하고 JayBus에 발행.

  구독 카테고리: cs.AI, cs.LG, cs.CL, cs.SE, stat.ML
  RSS URL: https://rss.arxiv.org/rss/{category}
  Kill Switch: DARWIN_SENSOR_ARXIV_ENABLED (기본 true)

  ETS 캐시로 24시간 내 중복 제거.
  emit 형식:
    %{title: "", url: "", abstract: "", source: "arxiv_rss", published_at: ~U[...]}
  """

  use GenServer
  require Logger

  @poll_interval_ms 30 * 60 * 1_000
  @dedup_ttl_ms 24 * 60 * 60 * 1_000
  @categories ["cs.AI", "cs.LG", "cs.CL", "cs.SE", "stat.ML"]
  @base_url "https://rss.arxiv.org/rss"
  @log_prefix "[다윈V2 센서:arxiv]"

  # Public API

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 스캔 트리거 (테스트 / 수동 호출용)."
  def scan_now do
    GenServer.cast(__MODULE__, :scan_now)
  end

  @doc "현재 ETS 캐시의 중복 제거 ID 수 반환."
  def dedup_cache_size do
    GenServer.call(__MODULE__, :dedup_cache_size)
  end

  # GenServer callbacks

  @impl GenServer
  def init(_opts) do
    table = :ets.new(:darwin_arxiv_dedup, [:set, :private])
    if enabled?() do
      schedule_poll(0)
      Logger.info("#{@log_prefix} 시작 (카테고리: #{Enum.join(@categories, ", ")})")
    else
      Logger.info("#{@log_prefix} 비활성 (DARWIN_SENSOR_ARXIV_ENABLED != true)")
    end
    {:ok, %{table: table, emitted: 0}}
  end

  @impl GenServer
  def handle_cast(:scan_now, state) do
    new_state = do_scan(state)
    {:noreply, new_state}
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
    emitted = Enum.reduce(@categories, 0, fn cat, acc ->
      acc + scan_category(cat, state.table)
    end)
    Logger.info("#{@log_prefix} 스캔 완료 — 신규 #{emitted}건 발행")
    %{state | emitted: state.emitted + emitted}
  end

  defp scan_category(category, table) do
    url = "#{@base_url}/#{category}"
    case Req.get(url, receive_timeout: 15_000) do
      {:ok, %{status: 200, body: body}} ->
        entries = parse_rss(body)
        Enum.reduce(entries, 0, fn entry, acc ->
          if already_seen?(table, entry.arxiv_id) do
            acc
          else
            mark_seen(table, entry.arxiv_id)
            emit(Map.delete(entry, :arxiv_id))
            acc + 1
          end
        end)

      {:ok, %{status: status}} ->
        Logger.warning("#{@log_prefix} #{category} HTTP #{status}")
        0

      {:error, reason} ->
        Logger.error("#{@log_prefix} #{category} 요청 실패: #{inspect(reason)}")
        0
    end
  end

  defp parse_rss(xml_body) do
    # :xmerl_scan으로 RSS XML 파싱
    try do
      xml_chars = String.to_charlist(xml_body)
      {doc, _} = :xmerl_scan.string(xml_chars, quiet: true)
      items = :xmerl_xpath.string(~c"//item", doc)
      Enum.flat_map(items, &parse_item/1)
    rescue
      e ->
        Logger.warning("#{@log_prefix} XML 파싱 실패, 폴백 파싱 시도: #{inspect(e)}")
        parse_rss_fallback(xml_body)
    end
  end

  defp parse_item(item) do
    title    = extract_text(item, ~c"title")
    link     = extract_text(item, ~c"link")
    desc     = extract_text(item, ~c"description")
    pub_date = extract_text(item, ~c"pubDate")

    arxiv_id = extract_arxiv_id(link)
    if is_nil(arxiv_id) do
      []
    else
      [%{
        arxiv_id: arxiv_id,
        title: clean_text(title),
        url: link,
        abstract: clean_text(desc),
        source: "arxiv_rss",
        published_at: parse_date(pub_date)
      }]
    end
  end

  defp extract_text(node, tag) do
    xpath = String.to_charlist("#{tag}/text()")
    case :xmerl_xpath.string(xpath, node) do
      [text_node | _] ->
        :xmerl.export_simple_content([text_node], :xmerl_xml) |> to_string() |> String.trim()
      _ -> ""
    end
  rescue
    _ -> ""
  end

  # 폴백: 정규식 기반 간단 파싱
  defp parse_rss_fallback(body) do
    Regex.scan(~r/<item>(.*?)<\/item>/s, body, capture: :first)
    |> Enum.flat_map(fn [item_xml] ->
      title   = extract_regex(item_xml, ~r/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/s)
      link    = extract_regex(item_xml, ~r/<link>(.*?)<\/link>/s)
      desc    = extract_regex(item_xml, ~r/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s)
      pub_str = extract_regex(item_xml, ~r/<pubDate>(.*?)<\/pubDate>/s)
      arxiv_id = extract_arxiv_id(link)

      if is_nil(arxiv_id) or link == "" do
        []
      else
        [%{
          arxiv_id: arxiv_id,
          title: clean_text(title),
          url: link,
          abstract: clean_text(desc),
          source: "arxiv_rss",
          published_at: parse_date(pub_str)
        }]
      end
    end)
  end

  defp extract_regex(text, regex) do
    case Regex.run(regex, text, capture: :all_but_first) do
      [cap | rest] -> Enum.find([cap | rest], "", &(&1 != "")) |> String.trim()
      _ -> ""
    end
  end

  defp extract_arxiv_id(url) when is_binary(url) do
    case Regex.run(~r/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/i, url) do
      [_, id] -> id
      _ -> nil
    end
  end
  defp extract_arxiv_id(_), do: nil

  defp clean_text(text) do
    text
    |> String.replace(~r/<[^>]+>/, "")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
  end

  defp parse_date(""), do: DateTime.utc_now()
  defp parse_date(str) do
    # RFC 2822 예: "Mon, 01 Jan 2025 00:00:00 +0000"
    case DateTime.from_iso8601(str) do
      {:ok, dt, _} -> dt
      _ ->
          # Timex 없으면 현재 시각 폴백
        DateTime.utc_now()
    end
  rescue
    _ -> DateTime.utc_now()
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
    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, paper})
    end)
  end

  defp schedule_poll(delay_ms) do
    Process.send_after(self(), :poll, delay_ms)
  end

  defp enabled? do
    System.get_env("DARWIN_SENSOR_ARXIV_ENABLED", "true") == "true"
  end
end

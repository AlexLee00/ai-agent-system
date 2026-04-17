defmodule Darwin.V2.Sensor.OpenReview do
  @moduledoc """
  OpenReview 센서 — 6시간 주기로 NeurIPS/ICML/ICLR 논문 수집.

  API: https://api2.openreview.net/notes
  대상 컨퍼런스: NeurIPS 2025, ICML 2025, ICLR 2025
  필터: rating >= 7 (고품질 논문만)
  ETS 중복 제거 (7일).
  Kill Switch: DARWIN_SENSOR_OPENREVIEW_ENABLED (기본 true)
  """

  use GenServer
  require Logger

  @poll_interval_ms 6 * 60 * 60 * 1_000
  @dedup_ttl_ms 7 * 24 * 60 * 60 * 1_000
  @min_rating 7.0
  @page_size 50
  @log_prefix "[다윈V2 센서:OpenReview]"
  @api_base "https://api2.openreview.net"

  @venues [
    %{id: "NeurIPS.cc/2025/Conference/-/Submission", name: "NeurIPS"},
    %{id: "ICML.cc/2025/Conference/-/Submission", name: "ICML"},
    %{id: "ICLR.cc/2025/Conference/-/Submission", name: "ICLR"}
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
    table = :ets.new(:darwin_openreview_dedup, [:set, :private])
    if enabled?() do
      schedule_poll(0)
      Logger.info("#{@log_prefix} 시작 (컨퍼런스: NeurIPS/ICML/ICLR 2025)")
    else
      Logger.info("#{@log_prefix} 비활성 (DARWIN_SENSOR_OPENREVIEW_ENABLED != true)")
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
    emitted = Enum.reduce(@venues, 0, fn venue, acc ->
      acc + scan_venue(venue, state.table)
    end)
    Logger.info("#{@log_prefix} 스캔 완료 — 신규 #{emitted}건 발행")
    %{state | emitted: state.emitted + emitted}
  end

  defp scan_venue(%{id: venue_id, name: venue_name}, table) do
    scan_venue_pages(venue_id, venue_name, table, 0, 0)
  end

  defp scan_venue_pages(venue_id, venue_name, table, offset, acc) do
    url = "#{@api_base}/notes?invitation=#{URI.encode(venue_id)}&limit=#{@page_size}&offset=#{offset}"

    case Req.get(url, receive_timeout: 20_000, headers: [{"User-Agent", "darwin-research-bot/2.0"}]) do
      {:ok, %{status: 200, body: body}} ->
        notes = Map.get(body, "notes", [])
        total = Map.get(body, "count", 0)

        emitted = notes
        |> Enum.reduce(0, fn note, nacc ->
          note_id = Map.get(note, "id", "")
          if already_seen?(table, note_id) or note_id == "" do
            nacc
          else
            mark_seen(table, note_id)
            nacc + maybe_emit_note(note, venue_name)
          end
        end)

        next_offset = offset + length(notes)
        new_acc = acc + emitted

        # 다음 페이지가 있고 아직 읽지 않은 경우 계속
        if length(notes) == @page_size and next_offset < total do
          Process.sleep(1_000)  # API 부하 방지
          scan_venue_pages(venue_id, venue_name, table, next_offset, new_acc)
        else
          new_acc
        end

      {:ok, %{status: 404}} ->
        # 아직 열리지 않은 컨퍼런스 invitation
        Logger.debug("#{@log_prefix} #{venue_name} invitation 미개방 (404) — 건너뜀")
        acc

      {:ok, %{status: status}} ->
        Logger.warning("#{@log_prefix} #{venue_name} HTTP #{status}")
        acc

      {:error, reason} ->
        Logger.error("#{@log_prefix} #{venue_name} 요청 실패: #{inspect(reason)}")
        acc
    end
  end

  defp maybe_emit_note(note, venue_name) do
    content  = Map.get(note, "content", %{})
    title    = get_field(content, "title")
    abstract = get_field(content, "abstract")
    note_id  = Map.get(note, "id", "")
    forum    = Map.get(note, "forum", note_id)

    # 평균 rating 계산
    avg_rating = extract_avg_rating(note)

    if avg_rating >= @min_rating or is_nil(avg_rating) do
      # nil은 rating이 없는 경우 (spotlight/oral 태그로 이미 선별된 경우)
      arxiv_url = extract_arxiv_url(content)
      paper_url = arxiv_url || "https://openreview.net/forum?id=#{forum}"

      paper = %{
        title: title,
        url: paper_url,
        abstract: abstract,
        source: "openreview",
        published_at: note_cdate(note),
        venue: venue_name,
        metadata: %{
          openreview_id: note_id,
          avg_rating: avg_rating
        }
      }
      emit(paper)
      1
    else
      0
    end
  end

  defp get_field(content, key) do
    case Map.get(content, key) do
      %{"value" => v} when is_binary(v) -> String.trim(v)
      v when is_binary(v) -> String.trim(v)
      _ -> ""
    end
  end

  defp extract_avg_rating(note) do
    # OpenReview v2 API: replies 내 rating 집계
    # 간단히 note content에서 rating 필드 확인
    content = Map.get(note, "content", %{})
    case Map.get(content, "rating") do
      %{"value" => v} when is_binary(v) ->
        case Float.parse(v) do
          {f, _} -> f
          :error ->
            case Integer.parse(v) do
              {i, _} -> i * 1.0
              :error -> nil
            end
        end
      v when is_number(v) -> v * 1.0
      _ -> nil
    end
  end

  defp extract_arxiv_url(content) do
    # content의 pdf, html, ee 필드에서 arxiv URL 탐색
    fields = ["pdf", "html", "ee", "code", "abstract"]
    Enum.find_value(fields, fn field ->
      val = get_field(content, field)
      case Regex.run(~r/https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/\d{4}\.\d{4,5}(?:v\d+)?/i, val) do
        [url] -> url
        _ -> nil
      end
    end)
  end

  defp note_cdate(note) do
    case Map.get(note, "cdate") do
      ts when is_integer(ts) ->
        case DateTime.from_unix(div(ts, 1000)) do
          {:ok, dt} -> dt
          _ -> DateTime.utc_now()
        end
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
    Registry.dispatch(Jay.Core.JayBus, topic, fn entries ->
      for {pid, _} <- entries, do: send(pid, {:jay_event, topic, paper})
    end)
  end

  defp schedule_poll(delay_ms) do
    Process.send_after(self(), :poll, delay_ms)
  end

  defp enabled? do
    System.get_env("DARWIN_SENSOR_OPENREVIEW_ENABLED", "true") == "true"
  end
end

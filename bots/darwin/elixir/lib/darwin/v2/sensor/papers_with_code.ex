defmodule Darwin.V2.Sensor.PapersWithCode do
  @moduledoc """
  Papers with Code 센서 — 6시간 주기로 최신 AI/ML 구현 논문 수집.

  API: https://paperswithcode.com/api/v1/papers/
  필터: github_stars >= 10 또는 tasks 있음 (실용성 높은 논문)
  ETS 중복 제거 (7일).
  Kill Switch: DARWIN_SENSOR_PWC_ENABLED (기본 true)
  """

  use GenServer
  require Logger

  @poll_interval_ms 6 * 60 * 60 * 1_000
  @dedup_ttl_ms 7 * 24 * 60 * 60 * 1_000
  @api_base "https://paperswithcode.com/api/v1"
  @page_size 50
  @min_stars 10
  @log_prefix "[다윈V2 센서:PapersWithCode]"

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
    table = :ets.new(:darwin_pwc_dedup, [:set, :private])

    if enabled?() do
      schedule_poll(0)
      Logger.info("#{@log_prefix} 시작 (Papers with Code API, 필터: stars>=#{@min_stars})")
    else
      Logger.info("#{@log_prefix} 비활성 (DARWIN_SENSOR_PWC_ENABLED != true)")
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
    emitted = scan_page(1, state.table, 0)
    Logger.info("#{@log_prefix} 스캔 완료 — 신규 #{emitted}건 발행")
    %{state | emitted: state.emitted + emitted}
  end

  defp scan_page(page, _table, acc) when page > 5, do: acc

  defp scan_page(page, table, acc) do
    url =
      "#{@api_base}/papers/?page=#{page}&items_per_page=#{@page_size}&format=json&ordering=-github_stars"

    case Req.get(url,
           receive_timeout: 20_000,
           headers: [{"User-Agent", "darwin-research-bot/2.0"}]
         ) do
      {:ok, %{status: 200, body: body}} ->
        case normalize_response_body(body) do
          {:ok, decoded} ->
            process_page_body(decoded, page, table, acc)

          {:error, _reason} ->
            Logger.warning(
              "#{@log_prefix} unexpected_body page=#{page} type=#{inspect(body_type(body))}; skip"
            )

            acc
        end

      {:ok, %{status: status}} ->
        Logger.warning("#{@log_prefix} HTTP #{status} (page #{page})")
        acc

      {:error, reason} ->
        Logger.error("#{@log_prefix} 요청 실패: #{inspect(reason)}")
        acc
    end
  end

  defp process_page_body(body, page, table, acc) when is_map(body) do
    results =
      case Map.get(body, "results", []) do
        list when is_list(list) -> list
        _ -> []
      end

    emitted =
      Enum.reduce(results, 0, fn
        paper, nacc when is_map(paper) ->
          paper_id = Map.get(paper, "id", "") |> to_string()

          if already_seen?(table, paper_id) or paper_id == "" do
            nacc
          else
            mark_seen(table, paper_id)
            nacc + maybe_emit_paper(paper)
          end

        _paper, nacc ->
          nacc
      end)

    total = Map.get(body, "count", 0)
    fetched = (page - 1) * @page_size + length(results)
    new_acc = acc + emitted

    if length(results) == @page_size and fetched < total do
      Process.sleep(1_500)
      scan_page(page + 1, table, new_acc)
    else
      new_acc
    end
  end

  @doc false
  def normalize_response_body(body) when is_map(body), do: {:ok, body}

  def normalize_response_body(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
      _ -> {:error, :unexpected_body}
    end
  end

  def normalize_response_body(_body), do: {:error, :unexpected_body}

  defp maybe_emit_paper(paper) do
    title = Map.get(paper, "title", "")
    arxiv_id = Map.get(paper, "arxiv_id", "")
    stars = Map.get(paper, "github_stars", 0) || 0
    tasks = Map.get(paper, "tasks", []) || []
    abstract = Map.get(paper, "abstract", "") || ""
    published = Map.get(paper, "published", "") || ""

    # 필터: stars >= @min_stars OR tasks 있음 (구현된 논문)
    if stars >= @min_stars or tasks != [] do
      url =
        if arxiv_id && arxiv_id != "" do
          "https://arxiv.org/abs/#{arxiv_id}"
        else
          "https://paperswithcode.com/paper/#{Map.get(paper, "id", "")}"
        end

      published_at =
        case DateTime.from_iso8601(published) do
          {:ok, dt, _} -> dt
          _ -> DateTime.utc_now()
        end

      emit(%{
        title: title,
        url: url,
        abstract: String.slice(abstract, 0, 1000),
        source: "papers_with_code",
        published_at: published_at,
        metadata: %{
          github_stars: stars,
          tasks: Enum.take(tasks, 5),
          arxiv_id: arxiv_id
        }
      })

      1
    else
      0
    end
  end

  defp body_type(body) when is_binary(body), do: :binary
  defp body_type(body) when is_list(body), do: :list
  defp body_type(body) when is_map(body), do: :map
  defp body_type(_), do: :unknown

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
    System.get_env("DARWIN_SENSOR_PWC_ENABLED", "true") == "true"
  end
end

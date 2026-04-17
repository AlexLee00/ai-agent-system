defmodule Darwin.V2.KeywordEvolver do
  @moduledoc """
  다윈 V2 키워드 이볼버 — 고성과 검색 키워드 학습 + 진화.

  TeamJay.Darwin.KeywordEvolver의 V2 포트. LLM 기반 스마트 진화 추가.

  역할:
  - 고품질 논문으로 이어지는 검색 키워드 학습
  - 성공적 구현 기반 키워드 효과성 점수 관리
  - 24시간 주기 Scanner 검색어 자동 업데이트

  트리거: applied() 이벤트 (키워드 → 논문 발견 → 구현 성공)
  알고리즘:
    1. 적용된 논문 제목/태그에서 키워드 추출
    2. 키워드 효과성 점수화: applied_count / discovered_count
    3. LLM으로 상위 키워드 5개 변형 생성
    4. darwin-keywords.json 파일에 저장
    5. Scanner가 다음 스캔 시 읽어 사용

  지속성: PROJECT_ROOT/bots/darwin/sandbox/darwin-keywords.json
  스케줄: 24시간 주기 자동 진화
  """

  use GenServer
  require Logger

  alias Darwin.V2.Topics

  @evolve_interval_ms 24 * 60 * 60 * 1000  # 24시간

  @initial_keywords [
    "transformer", "LLM", "language model", "neural architecture",
    "reinforcement learning", "agent", "RAG", "code generation",
    "multimodal", "embedding"
  ]

  @keywords_file_path "bots/darwin/sandbox/darwin-keywords.json"

  defstruct [
    keywords: [],
    evolution_count: 0,
    last_evolved_at: nil
  ]

  # ──────────────────────────────────────────────
  # 공개 API
  # ──────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "현재 모든 키워드 목록 반환."
  @spec get_keywords() :: [String.t()]
  def get_keywords do
    GenServer.call(__MODULE__, :get_keywords)
  end

  @doc "효과성 점수 상위 n개 키워드 반환."
  @spec get_top_keywords(non_neg_integer()) :: [String.t()]
  def get_top_keywords(n \\ 20) do
    GenServer.call(__MODULE__, {:get_top_keywords, n})
  end

  @doc "즉시 키워드 진화 실행 (수동 트리거)."
  @spec evolve_now() :: {:ok, [String.t()]} | {:error, term()}
  def evolve_now do
    GenServer.call(__MODULE__, :evolve_now, 60_000)
  end

  @doc "키워드 성공 기록 (논문이 해당 키워드로 발견됨)."
  @spec record_keyword_success(String.t(), String.t()) :: :ok
  def record_keyword_success(keyword, paper_url) do
    GenServer.cast(__MODULE__, {:record_keyword_success, keyword, paper_url})
  end

  # ──────────────────────────────────────────────
  # GenServer 콜백
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    Process.send_after(self(), :subscribe_events, 3_000)
    Process.send_after(self(), :evolve_keywords, @evolve_interval_ms)
    Logger.info("[다윈V2 키워드진화] 시작!")
    initial = load_keywords_from_file()
    {:ok, %__MODULE__{keywords: initial}}
  end

  @impl GenServer
  def handle_info(:subscribe_events, state) do
    Registry.register(TeamJay.JayBus, Topics.applied("darwin"), [])
    Registry.register(TeamJay.JayBus, Topics.keyword_evolved(), [])
    Logger.debug("[다윈V2 키워드진화] JayBus 구독 완료")
    {:noreply, state}
  end

  def handle_info(:evolve_keywords, state) do
    new_state = do_evolve(state)
    Process.send_after(self(), :evolve_keywords, @evolve_interval_ms)
    {:noreply, new_state}
  end

  def handle_info({:jay_event, topic, payload}, state) do
    new_state = handle_bus_event(topic, payload, state)
    {:noreply, new_state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast({:record_keyword_success, keyword, paper_url}, state) do
    Task.start(fn -> update_keyword_score(keyword, paper_url) end)
    {:noreply, state}
  end

  @impl GenServer
  def handle_call(:get_keywords, _from, state) do
    {:reply, state.keywords, state}
  end

  def handle_call({:get_top_keywords, n}, _from, state) do
    top = fetch_top_keywords_from_file(n)
    {:reply, top, state}
  end

  def handle_call(:evolve_now, _from, state) do
    new_state = do_evolve(state)
    result = {:ok, new_state.keywords}
    {:reply, result, new_state}
  end

  # ──────────────────────────────────────────────
  # 내부 — JayBus 이벤트
  # ──────────────────────────────────────────────

  defp handle_bus_event(topic, payload, state) do
    cond do
      topic == Topics.applied("darwin") ->
        Task.start(fn -> extract_and_record_keywords(payload) end)
        state

      topic == Topics.keyword_evolved() ->
        keywords = get_field(payload, :keywords, get_field(payload, "keywords", []))
        Logger.info("[다윈V2 키워드진화] 외부 키워드 진화 이벤트 수신: #{length(keywords)}개")
        if keywords != [], do: save_keywords_to_file(keywords)
        %{state | keywords: keywords, last_evolved_at: DateTime.utc_now()}

      true ->
        state
    end
  end

  # ──────────────────────────────────────────────
  # 내부 — 진화 로직
  # ──────────────────────────────────────────────

  defp do_evolve(state) do
    Logger.info("[다윈V2 키워드진화] 키워드 진화 시작...")

    top_keywords = fetch_top_keywords_from_file(10)

    case generate_evolved_keywords(top_keywords) do
      {:ok, new_keywords} ->
        merged = merge_keywords(state.keywords, new_keywords)
        save_keywords_to_file(merged)
        Logger.info("[다윈V2 키워드진화] 진화 완료: #{length(merged)}개 키워드")
        %{state |
          keywords:        merged,
          evolution_count: state.evolution_count + 1,
          last_evolved_at: DateTime.utc_now()
        }

      {:error, reason} ->
        Logger.warning("[다윈V2 키워드진화] LLM 진화 실패: #{inspect(reason)} — 기존 유지")
        state
    end
  end

  defp generate_evolved_keywords([]) do
    {:ok, @initial_keywords}
  end

  defp generate_evolved_keywords(top_keywords) do
    prompt = """
    다음은 AI 연구 논문 검색에 효과적인 상위 키워드들입니다:

    #{Enum.join(top_keywords, ", ")}

    이 키워드들의 패턴을 분석하여 비슷한 성격의 새로운 검색 키워드를 5개 제안해주세요.
    - 최신 AI/ML 트렌드를 반영
    - 구체적이고 검색 가능한 용어
    - 기존 키워드와 중복 최소화

    JSON 배열 형식으로만 응답: ["keyword1", "keyword2", ...]
    """

    case Darwin.V2.LLM.Selector.call_with_fallback("darwin.scanner", prompt,
           max_tokens: 200,
           task_type: :keyword_extraction
         ) do
      {:ok, response} when is_binary(response) ->
        parse_keywords_from_llm(response)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp parse_keywords_from_llm(response) do
    # JSON 배열 추출
    case Regex.run(~r/\[.*\]/s, response) do
      [json_str] ->
        case Jason.decode(json_str) do
          {:ok, keywords} when is_list(keywords) ->
            valid = Enum.filter(keywords, &is_binary/1)
            {:ok, valid}

          _ ->
            {:error, :json_decode_failed}
        end

      _ ->
        # 줄 기반 파싱 폴백
        keywords =
          response
          |> String.split("\n")
          |> Enum.map(&String.trim/1)
          |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "#") or String.starts_with?(&1, "[")))
          |> Enum.map(fn k ->
            k
            |> String.replace(~r/^[\d\.\-\*\•]+\s*/, "")
            |> String.replace(~r/["',]/, "")
            |> String.trim()
          end)
          |> Enum.reject(&(&1 == ""))
          |> Enum.take(10)

        if keywords == [], do: {:error, :no_keywords_found}, else: {:ok, keywords}
    end
  end

  defp extract_and_record_keywords(payload) do
    title = get_field(payload, :title, get_field(payload, "title", ""))
    tags  = get_field(payload, :tags,  get_field(payload, "tags",  []))
    url   = get_field(payload, :url,   get_field(payload, "url",   ""))

    keywords_from_title = extract_keywords_from_title(title)
    all_keywords = (keywords_from_title ++ tags) |> Enum.uniq()

    Enum.each(all_keywords, fn kw ->
      update_keyword_score(kw, url)
    end)
  rescue
    e -> Logger.warning("[다윈V2 키워드진화] 키워드 추출 실패: #{Exception.message(e)}")
  end

  defp extract_keywords_from_title(""), do: []

  defp extract_keywords_from_title(title) do
    # 공백 기준 분리, 3자 이상 단어 추출
    title
    |> String.downcase()
    |> String.split(~r/[\s\-_:,\.]+/)
    |> Enum.filter(fn word -> String.length(word) >= 3 end)
    |> Enum.reject(fn word -> word in ~w(the and for with from this that are was were) end)
    |> Enum.take(10)
  end

  defp update_keyword_score(keyword, _paper_url) do
    data = load_keywords_json()

    updated =
      case Enum.find_index(data, fn k -> k["keyword"] == keyword end) do
        nil ->
          [%{
            "keyword"  => keyword,
            "score"    => 1.0,
            "used_at"  => DateTime.utc_now() |> DateTime.to_iso8601(),
            "source"   => "evolved"
          } | data]

        idx ->
          List.update_at(data, idx, fn k ->
            Map.update(k, "score", 1.0, &(&1 + 1.0))
            |> Map.put("used_at", DateTime.utc_now() |> DateTime.to_iso8601())
          end)
      end

    save_raw_json(updated)
  rescue
    e -> Logger.warning("[다윈V2 키워드진화] 점수 업데이트 실패: #{Exception.message(e)}")
  end

  defp merge_keywords(existing, new_keywords) do
    existing_set = MapSet.new(existing)

    added =
      new_keywords
      |> Enum.reject(&MapSet.member?(existing_set, &1))

    (existing ++ added)
    |> Enum.uniq()
    |> Enum.take(100)
  end

  # ──────────────────────────────────────────────
  # 내부 — 파일 I/O
  # ──────────────────────────────────────────────

  defp keywords_file_path do
    project_root = System.get_env("PROJECT_ROOT", File.cwd!())
    Path.join(project_root, @keywords_file_path)
  end

  defp load_keywords_from_file do
    path = keywords_file_path()

    case File.read(path) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, data} when is_list(data) ->
            Enum.map(data, fn
              %{"keyword" => kw} -> kw
              kw when is_binary(kw) -> kw
              _ -> nil
            end)
            |> Enum.reject(&is_nil/1)

          _ ->
            @initial_keywords
        end

      {:error, _} ->
        Logger.info("[다윈V2 키워드진화] 키워드 파일 없음 — 초기 키워드 사용")
        @initial_keywords
    end
  end

  defp load_keywords_json do
    path = keywords_file_path()

    case File.read(path) do
      {:ok, content} ->
        case Jason.decode(content) do
          {:ok, data} when is_list(data) ->
            # 문자열 목록 → 구조체로 변환
            Enum.map(data, fn
              %{"keyword" => _} = k -> k
              kw when is_binary(kw) ->
                %{"keyword" => kw, "score" => 1.0, "used_at" => nil, "source" => "initial"}
              _ -> nil
            end)
            |> Enum.reject(&is_nil/1)

          _ -> initial_keyword_structs()
        end

      {:error, _} -> initial_keyword_structs()
    end
  end

  defp initial_keyword_structs do
    Enum.map(@initial_keywords, fn kw ->
      %{"keyword" => kw, "score" => 1.0, "used_at" => nil, "source" => "initial"}
    end)
  end

  defp fetch_top_keywords_from_file(n) do
    load_keywords_json()
    |> Enum.sort_by(fn k -> Map.get(k, "score", 0.0) end, :desc)
    |> Enum.take(n)
    |> Enum.map(fn k -> k["keyword"] end)
  end

  defp save_keywords_to_file(keywords) do
    data =
      Enum.map(keywords, fn
        %{"keyword" => _} = k -> k
        kw when is_binary(kw) ->
          %{
            "keyword" => kw,
            "score"   => 1.0,
            "used_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
            "source"  => "evolved"
          }
      end)

    save_raw_json(data)
  end

  defp save_raw_json(data) do
    path = keywords_file_path()
    dir  = Path.dirname(path)

    File.mkdir_p!(dir)

    case Jason.encode(data, pretty: true) do
      {:ok, json} ->
        File.write!(path, json)
        Logger.debug("[다윈V2 키워드진화] 키워드 파일 저장 완료 (#{length(data)}개)")

      {:error, reason} ->
        Logger.warning("[다윈V2 키워드진화] JSON 인코딩 실패: #{inspect(reason)}")
    end
  rescue
    e -> Logger.warning("[다윈V2 키워드진화] 파일 저장 실패: #{Exception.message(e)}")
  end

  defp get_field(map, key, default) when is_map(map) do
    Map.get(map, key, default)
  end

  defp get_field(_map, _key, default), do: default
end

defmodule Darwin.V2.Cycle.Discover do
  @moduledoc """
  다윈 V2 Discover 사이클 GenServer — 7단계 R&D 루프의 Discover 단계.

  Phase A 통합: DARWIN_TEAM_INTEGRATION_ENABLED=true 시
  - 매 실행마다 pending 팀 기술 요청 큐를 우선 조회
  - 요청 팀의 키워드를 가중치 높여 arXiv 검색에 포함
  - 발견된 논문을 요청 ID와 연관하여 ResearchRegistry 등록
  """

  use GenServer
  require Logger

  alias Darwin.V2.ResearchRegistry
  alias Darwin.V2.TeamConnector

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(_opts) do
    Logger.info("[darwin/cycle.discover] Discover 단계 기동")
    {:ok, %{runs: 0, last_run_at: nil}}
  end

  @doc "이 단계를 즉시 실행."
  def run_now(payload \\ %{}) do
    GenServer.cast(__MODULE__, {:run, payload})
  end

  @doc "현재 상태 조회."
  def status, do: GenServer.call(__MODULE__, :status)

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, Map.put(state, :phase, :discover), state}
  end

  @impl GenServer
  def handle_cast({:run, payload}, state) do
    Logger.debug("[darwin/cycle.discover] Discover 실행 — payload=#{inspect(payload)}")

    # Phase A: 팀 기술 요청 큐 우선 처리
    team_requests = TeamConnector.pending_requests()
    if team_requests != [] do
      Logger.info("[darwin/cycle.discover] 팀 기술 요청 #{length(team_requests)}건 발견 — 우선 키워드 확장")
      log_team_request_keywords(team_requests)
    end

    # 신규 논문 발견 시 Research Registry에 등록
    paper = Map.get(payload, :paper)
    if paper && Map.get(paper, :paper_id) do
      # 팀 요청과 논문 매칭 (키워드 기반)
      matched_request_ids = match_requests_to_paper(paper, team_requests)
      enriched_paper = Map.put(paper, :matched_request_ids, matched_request_ids)
      ResearchRegistry.register_paper(enriched_paper)
    end

    new_state = %{state | runs: state.runs + 1, last_run_at: DateTime.utc_now()}
    {:noreply, new_state}
  end

  @doc """
  팀 기술 요청 큐에서 추가 검색 키워드 목록을 반환.
  DISCOVER 단계에서 arXiv 쿼리에 추가 투입.
  """
  @spec request_keywords() :: [%{team: String.t(), keywords: [String.t()], request_id: integer()}]
  def request_keywords do
    TeamConnector.pending_requests()
    |> Enum.map(fn req ->
      %{
        team: to_string(req[:requesting_team] || req["requesting_team"] || ""),
        keywords: extract_keywords(req[:description] || req["description"] || ""),
        request_id: req[:id] || req["id"]
      }
    end)
    |> Enum.reject(fn %{keywords: kws} -> kws == [] end)
  end

  # ────────────────────────────────────────────────
  # Private
  # ────────────────────────────────────────────────

  defp log_team_request_keywords(requests) do
    requests
    |> Enum.each(fn req ->
      team = req[:requesting_team] || req["requesting_team"]
      desc = req[:description] || req["description"]
      Logger.debug("[darwin/cycle.discover] 팀 요청 키워드 team=#{team} desc=#{String.slice(desc, 0, 80)}")
    end)
  end

  defp match_requests_to_paper(paper, requests) do
    title = String.downcase(paper[:title] || paper["title"] || "")
    abstract = String.downcase(paper[:abstract] || paper["abstract"] || "")
    full_text = "#{title} #{abstract}"

    requests
    |> Enum.filter(fn req ->
      keywords = extract_keywords(req[:description] || req["description"] || "")
      Enum.any?(keywords, &String.contains?(full_text, String.downcase(&1)))
    end)
    |> Enum.map(fn req -> req[:id] || req["id"] end)
    |> Enum.reject(&is_nil/1)
  end

  defp extract_keywords(description) do
    description
    |> String.split(~r/[\s,;]+/, trim: true)
    |> Enum.filter(&(String.length(&1) >= 4))
    |> Enum.take(10)
  end
end

defmodule TeamJay.Ska.SelectorManager do
  @moduledoc """
  스카팀 셀렉터 히스토리 관리
  (자기 복구 Loop 2 - 셀렉터 버전 관리)

  Kadoa 패턴 적용:
    - 과거 작동했던 셀렉터 버전별 저장
    - 현재 셀렉터 실패 → 과거 버전 순차 시도
    - LLM 생성 셀렉터 검증 (5회 연속 성공 시 promoted)
    - 실패 누적 시 deprecated

  상태 전이:
    active → (5회 연속 실패) → deprecated
    candidate → (5회 연속 성공) → promoted
    candidate → (실패 포함 10회) → deprecated
  """

  use GenServer
  require Logger

  @promote_threshold 5
  @deprecate_threshold 5
  # candidate가 @candidate_max_trials 이상 시도됐지만 promoted 안 된 경우 deprecate
  @candidate_max_trials 10

  defstruct [:cache]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "타겟의 현재 active 셀렉터 조회"
  def get_active(target) do
    GenServer.call(__MODULE__, {:get_active, target})
  end

  @doc "타겟의 모든 셀렉터 조회 (active + candidate + promoted)"
  def get_all(target) do
    GenServer.call(__MODULE__, {:get_all, target})
  end

  @doc "셀렉터 결과 기록 (성공/실패)"
  def record_result(selector_id, success?) do
    GenServer.cast(__MODULE__, {:record_result, selector_id, success?})
  end

  @doc "LLM이 생성한 새 셀렉터 등록 (candidate 상태)"
  def register_candidate(target, css, xpath, llm_provider) do
    GenServer.call(__MODULE__, {:register_candidate, target, css, xpath, llm_provider})
  end

  @doc "캐시 무효화 (DB 직접 변경 후)"
  def invalidate_cache(target) do
    GenServer.cast(__MODULE__, {:invalidate_cache, target})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[SelectorManager] 시작! 셀렉터 히스토리 관리")
    {:ok, %__MODULE__{cache: %{}}}
  end

  @impl true
  def handle_call({:get_active, target}, _from, state) do
    case Map.get(state.cache, target) do
      nil ->
        selectors = fetch_active_selectors(target)
        new_cache = Map.put(state.cache, target, selectors)
        {:reply, selectors, %{state | cache: new_cache}}
      cached ->
        {:reply, cached, state}
    end
  end

  @impl true
  def handle_call({:get_all, target}, _from, state) do
    rows = fetch_all_selectors(target)
    {:reply, rows, state}
  end

  @impl true
  def handle_call({:register_candidate, target, css, xpath, llm_provider}, _from, state) do
    result = insert_candidate(target, css, xpath, llm_provider)
    # 해당 타겟 캐시 무효화
    new_cache = Map.delete(state.cache, target)
    {:reply, result, %{state | cache: new_cache}}
  end

  @impl true
  def handle_cast({:record_result, selector_id, success?}, state) do
    Task.start(fn -> update_selector_stats(selector_id, success?) end)
    {:noreply, state}
  end

  @impl true
  def handle_cast({:invalidate_cache, target}, state) do
    {:noreply, %{state | cache: Map.delete(state.cache, target)}}
  end

  # ─── Private: DB 연동 ─────────────────────────────────────

  defp fetch_active_selectors(target) do
    sql = """
    SELECT id, target, selector_css, selector_xpath, version, status,
           success_count, fail_count, consecutive_ok, consecutive_fail,
           llm_generated, llm_provider
    FROM ska.selector_history
    WHERE target = $1 AND status IN ('active', 'promoted', 'candidate')
    ORDER BY
      CASE status WHEN 'promoted' THEN 1 WHEN 'active' THEN 2 ELSE 3 END,
      success_count DESC
    """
    query_rows(sql, [target])
  end

  defp fetch_all_selectors(target) do
    sql = """
    SELECT id, target, selector_css, selector_xpath, version, status,
           success_count, fail_count, consecutive_ok, consecutive_fail,
           llm_generated, llm_provider, created_at
    FROM ska.selector_history
    WHERE target = $1
    ORDER BY created_at DESC
    """
    query_rows(sql, [target])
  end

  defp insert_candidate(target, css, xpath, llm_provider) do
    sql = """
    INSERT INTO ska.selector_history
      (target, selector_css, selector_xpath, status, llm_generated, llm_provider)
    VALUES ($1, $2, $3, 'candidate', TRUE, $4)
    RETURNING id
    """
    case TeamJay.Repo.query(sql, [target, css, xpath, llm_provider]) do
      {:ok, %{rows: [[id]]}} ->
        Logger.info("[SelectorManager] 신규 candidate #{id} 등록: #{target}")
        {:ok, id}
      {:error, err} ->
        Logger.error("[SelectorManager] candidate 등록 실패: #{inspect(err)}")
        {:error, err}
    end
  end

  defp update_selector_stats(selector_id, success?) do
    {ok_delta, fail_delta} = if success?, do: {1, 0}, else: {0, 1}

    sql = """
    UPDATE ska.selector_history SET
      success_count    = success_count + $2,
      fail_count       = fail_count + $3,
      consecutive_ok   = CASE WHEN $4 THEN consecutive_ok + 1 ELSE 0 END,
      consecutive_fail = CASE WHEN $5 THEN consecutive_fail + 1 ELSE 0 END
    WHERE id = $1
    RETURNING status, consecutive_ok, consecutive_fail
    """
    case TeamJay.Repo.query(sql, [selector_id, ok_delta, fail_delta, success?, not success?]) do
      {:ok, %{rows: [[status, consec_ok, consec_fail]]}} ->
        check_promotion(selector_id, status, consec_ok, consec_fail)
      {:error, err} ->
        Logger.error("[SelectorManager] stats 업데이트 실패: #{inspect(err)}")
    end
  end

  defp check_promotion(selector_id, "candidate", consec_ok, _consec_fail)
    when consec_ok >= @promote_threshold do
    promote_selector(selector_id)
  end

  defp check_promotion(selector_id, status, _consec_ok, consec_fail)
    when consec_fail >= @deprecate_threshold and status in ["active", "candidate"] do
    deprecate_selector(selector_id)
  end

  # candidate가 @candidate_max_trials 초과 시도됐으나 promoted 안 됐으면 deprecate
  defp check_promotion(selector_id, "candidate", consec_ok, consec_fail)
    when consec_ok + consec_fail >= @candidate_max_trials do
    Logger.warning("[SelectorManager] candidate #{selector_id} #{@candidate_max_trials}회 초과 미승격 → deprecate")
    deprecate_selector(selector_id)
  end

  defp check_promotion(_id, _status, _ok, _fail), do: :ok

  defp promote_selector(selector_id) do
    sql = """
    UPDATE ska.selector_history SET
      status = 'promoted', promoted_at = NOW()
    WHERE id = $1
    RETURNING target
    """
    case TeamJay.Repo.query(sql, [selector_id]) do
      {:ok, %{rows: [[target]]}} ->
        Logger.info("[SelectorManager] ✅ 셀렉터 #{selector_id} promoted! (#{target})")
        TeamJay.Ska.PubSub.broadcast_selector_promoted(target, selector_id)
      _ -> :ok
    end
  end

  defp deprecate_selector(selector_id) do
    sql = """
    UPDATE ska.selector_history SET
      status = 'deprecated', deprecated_at = NOW()
    WHERE id = $1
    RETURNING target
    """
    case TeamJay.Repo.query(sql, [selector_id]) do
      {:ok, %{rows: [[target]]}} ->
        Logger.warning("[SelectorManager] ❌ 셀렉터 #{selector_id} deprecated (#{target})")
        TeamJay.Ska.PubSub.broadcast_selector_deprecated(target, selector_id)
      _ -> :ok
    end
  end

  defp query_rows(sql, params) do
    case TeamJay.Repo.query(sql, params) do
      {:ok, %{rows: rows, columns: cols}} ->
        keys = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, fn row -> Enum.zip(keys, row) |> Map.new() end)
      {:error, err} ->
        Logger.error("[SelectorManager] query 실패: #{inspect(err)}")
        []
    end
  end
end

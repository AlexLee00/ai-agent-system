defmodule TeamJay.Ska.SkillRegistry do
  @moduledoc """
  스카팀 스킬 저장소 — 재사용 가능한 체크 루틴 중앙 관리.

  역할:
  - 스킬 등록/조회 (ETS 기반)
  - 스킬 버전 관리 (v1/v2 공존)
  - 스킬 사용 통계 (누가 몇 번 썼나)
  - 스킬 헬스체크 (자체 정상성)

  Kill Switch: SKA_SKILL_REGISTRY_ENABLED (기본 true)
  """

  use GenServer
  require Logger

  @table :ska_skill_registry
  @version "1.0"
  @enabled_env "SKA_SKILL_REGISTRY_ENABLED"

  defstruct [:skills, :stats, :started_at]

  # ─── 클라이언트 API ───────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "스킬 등록"
  def register(skill_name, module, metadata \\ %{}) do
    GenServer.call(__MODULE__, {:register, skill_name, module, metadata})
  end

  @doc "스킬 조회 (에이전트가 런타임에 호출)"
  def fetch(skill_name) do
    case :ets.lookup(@table, skill_name) do
      [{^skill_name, skill}] -> {:ok, skill}
      [] -> {:error, :skill_not_found}
    end
  end

  @doc "스킬 실행 + 통계 기록"
  def execute(skill_name, params, context \\ %{}) do
    if disabled?() do
      {:error, :skill_registry_disabled}
    else
      with {:ok, skill} <- fetch(skill_name) do
        start = System.monotonic_time(:millisecond)
        result = apply(skill.module, :run, [params, context])
        elapsed = System.monotonic_time(:millisecond) - start
        GenServer.cast(__MODULE__, {:record_execution, skill_name, result, elapsed, context})
        result
      end
    end
  end

  @doc "스킬 목록 (도메인/태그 필터)"
  def list(filter \\ %{}) do
    :ets.tab2list(@table)
    |> Enum.filter(fn {_name, skill} -> match_filter?(skill, filter) end)
    |> Enum.map(fn {_name, skill} -> skill end)
  end

  @doc "스킬 사용 통계"
  def stats(skill_name \\ nil) do
    GenServer.call(__MODULE__, {:stats, skill_name})
  end

  @doc "등록된 스킬 헬스체크"
  def health_check_all do
    list()
    |> Enum.map(fn skill ->
      result =
        if function_exported?(skill.module, :health_check, 0),
          do: apply(skill.module, :health_check, []),
          else: :ok

      {skill.name, result}
    end)
  end

  # ─── GenServer 콜백 ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    # named ETS 테이블 생성 — 이미 존재하면 기존 것 사용
    try do
      :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    catch
      :error, :badarg ->
        # 다른 프로세스가 이미 보유 중 — 기존 테이블 재사용 (테스트 환경)
        Logger.debug("[SkillRegistry] ETS 테이블 기존 재사용: #{@table}")
    end

    {:ok, %__MODULE__{skills: %{}, stats: %{}, started_at: DateTime.utc_now()},
     {:continue, :register_builtin_skills}}
  end

  @impl true
  def handle_continue(:register_builtin_skills, state) do
    new_state = do_register_builtin_skills(state)
    Logger.info("[SkillRegistry] 시작 (v#{@version}) — 내장 스킬 #{map_size(new_state.skills)}개 등록")
    {:noreply, new_state}
  end

  @impl true
  def handle_call({:register, name, module, meta}, _from, state) do
    skill = %{
      name: name,
      module: module,
      version: Map.get(meta, :version, "1.0"),
      domain: Map.get(meta, :domain, :general),
      description: Map.get(meta, :description, ""),
      input_schema: Map.get(meta, :input_schema, %{}),
      output_schema: Map.get(meta, :output_schema, %{}),
      registered_at: DateTime.utc_now()
    }

    :ets.insert(@table, {name, skill})
    Logger.info("[SkillRegistry] 스킬 등록: #{name} (#{module})")
    {:reply, {:ok, skill}, %{state | skills: Map.put(state.skills, name, skill)}}
  end

  @impl true
  def handle_call({:stats, nil}, _from, state) do
    {:reply, state.stats, state}
  end

  @impl true
  def handle_call({:stats, skill_name}, _from, state) do
    {:reply, Map.get(state.stats, skill_name, %{}), state}
  end

  @impl true
  def handle_cast({:record_execution, skill_name, result, elapsed, context}, state) do
    status =
      case result do
        {:ok, _} -> :success
        {:error, _} -> :failure
        _ -> :unknown
      end

    Task.start(fn -> persist_execution(skill_name, status, elapsed, context) end)

    skill_stats = Map.get(state.stats, skill_name, %{total: 0, success: 0, failure: 0})
    updated =
      skill_stats
      |> Map.update!(:total, &(&1 + 1))
      |> Map.update!(status, &(&1 + 1))

    {:noreply, put_in(state.stats[skill_name], updated)}
  end

  # ─── 내부 헬퍼 ───────────────────────────────────────────────

  defp disabled? do
    System.get_env(@enabled_env, "true") != "true"
  end

  defp match_filter?(_skill, filter) when map_size(filter) == 0, do: true

  defp match_filter?(skill, filter) do
    Enum.all?(filter, fn {k, v} -> Map.get(skill, k) == v end)
  end

  defp builtin_skills do
    [
      # Phase 1: 공통 스킬
      {:detect_session_expiry, TeamJay.Ska.Skill.DetectSessionExpiry, %{domain: :common}},
      {:notify_failure, TeamJay.Ska.Skill.NotifyFailure, %{domain: :common}},
      {:persist_cycle_metrics, TeamJay.Ska.Skill.PersistCycleMetrics, %{domain: :common}},
      {:trigger_recovery, TeamJay.Ska.Skill.TriggerRecovery, %{domain: :common}},
      {:audit_db_integrity, TeamJay.Ska.Skill.AuditDbIntegrity, %{domain: :common}},
      # Phase 2: 도메인 스킬
      {:parse_naver_html, TeamJay.Ska.Skill.ParseNaverHtml, %{domain: :naver}},
      {:classify_kiosk_state, TeamJay.Ska.Skill.ClassifyKioskState, %{domain: :kiosk}},
      {:audit_pos_transactions, TeamJay.Ska.Skill.AuditPosTransactions, %{domain: :pickko}},
      # Phase 3: 분석 스킬
      {:forecast_demand, TeamJay.Ska.Skill.ForecastDemand, %{domain: :analytics}},
      {:analyze_revenue, TeamJay.Ska.Skill.AnalyzeRevenue, %{domain: :analytics}},
      {:detect_anomaly, TeamJay.Ska.Skill.DetectAnomaly, %{domain: :analytics}},
      {:generate_report, TeamJay.Ska.Skill.GenerateReport, %{domain: :analytics}}
    ]
  end

  defp do_register_builtin_skills(state) do
    new_skills =
      Enum.reduce(builtin_skills(), state.skills, fn {name, module, meta}, acc ->
        skill = %{
          name: name,
          module: module,
          version: Map.get(meta, :version, "1.0"),
          domain: Map.get(meta, :domain, :general),
          description: Map.get(meta, :description, ""),
          input_schema: Map.get(meta, :input_schema, %{}),
          output_schema: Map.get(meta, :output_schema, %{}),
          registered_at: DateTime.utc_now()
        }

        :ets.insert(@table, {name, skill})
        Map.put(acc, name, skill)
      end)

    %{state | skills: new_skills}
  end

  defp persist_execution(skill_name, status, elapsed, context) do
    unless repo_available?() do
      Logger.debug("[SkillRegistry] Repo 미기동 환경 — 실행 로그 저장 생략: #{skill_name}")
      :ok
    else
      caller = Map.get(context, :caller_agent, "unknown")
      error_reason = if status == :failure, do: Map.get(context, :error_reason), else: nil

      sql = """
      INSERT INTO ska_skill_execution_log
        (skill_name, caller_agent, status, duration_ms, error_reason, input_summary, inserted_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      """

      args = [
        to_string(skill_name),
        to_string(caller),
        to_string(status),
        elapsed,
        error_reason,
        Jason.encode!(%{caller: caller})
      ]

      try do
        case Jay.Core.Repo.query(sql, args) do
          {:ok, _} -> :ok
          {:error, err} -> Logger.warning("[SkillRegistry] 실행 로그 저장 실패: #{inspect(err)}")
        end
      catch
        :exit, reason ->
          Logger.debug("[SkillRegistry] Repo 종료 경쟁 상태 — 실행 로그 저장 생략: #{inspect(reason)}")
      end
    end
  end

  defp repo_available? do
    Code.ensure_loaded?(Jay.Core.Repo) and Process.whereis(Jay.Core.Repo) != nil
  end
end

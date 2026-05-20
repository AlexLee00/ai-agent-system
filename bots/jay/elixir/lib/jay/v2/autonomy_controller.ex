defmodule Jay.V2.AutonomyController do
  @moduledoc """
  제이팀 자율화 단계 관리 GenServer.

  Phase 1 (감시):    일일 브리핑 + 모든 이벤트 텔레그램
  Phase 2 (반자율):  이상 시만 알림, 정상은 로그
  Phase 3 (자율):    주간 리포트만, 일일 완전 자율

  전환 조건:
    1 → 2: 7일 연속 이상 없음 (cross_pipeline 결정 escalate = 0)
    2 → 3: 30일 연속 마스터 개입 없음
  """

  use GenServer
  require Logger

  @phase_key "jay.autonomy_phase"
  @state_key "jay.autonomy_controller_state"
  @state_event_type "autonomy.controller_state_snapshot"
  # 매일
  @check_interval_ms 24 * 60 * 60 * 1_000

  defstruct phase: 1,
            phase_since: nil,
            consecutive_clean_days: 0,
            last_escalation_at: nil,
            master_intervention_count: 0

  # ────────────────────────────────────────────────────────────────
  # 공개 API
  # ────────────────────────────────────────────────────────────────

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def get_phase, do: GenServer.call(__MODULE__, :get_phase)
  def get_status, do: GenServer.call(__MODULE__, :get_status)

  @doc "마스터 개입 기록 (수동 알람 응답 등)"
  def record_master_intervention(metadata \\ %{}) do
    GenServer.cast(__MODULE__, {:master_intervention, metadata})
  end

  @doc "이상 없는 하루 기록"
  def record_clean_day do
    GenServer.cast(__MODULE__, :clean_day)
  end

  @doc "일일 사이클에서 알림 발송 여부 결정"
  def should_send_daily_briefing? do
    GenServer.call(__MODULE__, :should_send_briefing)
  end

  @doc "크로스 파이프라인 이벤트 발송 여부 결정"
  def should_notify_pipeline?(decision) do
    GenServer.call(__MODULE__, {:should_notify_pipeline, decision})
  end

  # ────────────────────────────────────────────────────────────────
  # GenServer 콜백
  # ────────────────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    state = load_state_from_db()
    save_state_to_db(state)
    Process.send_after(self(), :daily_check, @check_interval_ms)
    Logger.info("[AutonomyController] 시작! Phase #{state.phase} (#{phase_label(state.phase)})")
    {:ok, state}
  end

  @impl true
  def handle_call(:get_phase, _from, state) do
    {:reply, state.phase, state}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, Map.from_struct(state), state}
  end

  @impl true
  def handle_call(:should_send_briefing, _from, state) do
    # Phase 1: 항상 발송
    # Phase 2: 항상 발송 (이상 여부는 내용으로 결정)
    # Phase 3: 월요일만 발송 (주간 리포트)
    send? =
      case state.phase do
        # 월요일
        3 -> Date.day_of_week(kst_today()) == 1
        _ -> true
      end

    {:reply, send?, state}
  end

  @impl true
  def handle_call({:should_notify_pipeline, decision}, _from, state) do
    notify? =
      case {state.phase, decision} do
        # Phase 1: 모두 알림
        {1, _} -> true
        # Phase 2: escalate만
        {2, :escalate} -> true
        # Phase 2: block만
        {2, :block} -> true
        # Phase 3: escalate만
        {3, :escalate} -> true
        _ -> false
      end

    {:reply, notify?, state}
  end

  @impl true
  def handle_cast(:master_intervention, state) do
    handle_cast({:master_intervention, %{}}, state)
  end

  @impl true
  def handle_cast({:master_intervention, metadata}, state) do
    Logger.info("[AutonomyController] 마스터 개입 기록")
    cycle_id = next_cycle_id()
    record_master_intervention_event(metadata, cycle_id)

    new_state = %{
      state
      | master_intervention_count: state.master_intervention_count + 1,
        consecutive_clean_days: 0,
        last_escalation_at: DateTime.utc_now()
    }

    # Phase 3 → Phase 2 다운그레이드 검토
    new_state =
      if state.phase == 3 do
        Logger.warning("[AutonomyController] Phase 3 → Phase 2 다운그레이드 (마스터 개입)")
        broadcast_phase_change(3, 2)
        %{new_state | phase: 2, phase_since: kst_today()}
      else
        new_state
      end

    save_state_to_db(new_state)

    {:noreply, new_state}
  end

  @impl true
  def handle_cast(:clean_day, state) do
    days = state.consecutive_clean_days + 1
    new_state = %{state | consecutive_clean_days: days}

    # 전환 조건 체크
    new_state =
      cond do
        state.phase == 1 and days >= 7 ->
          Logger.info("[AutonomyController] Phase 1 → Phase 2 전환! (#{days}일 연속 이상 없음)")
          broadcast_phase_change(1, 2)
          %{new_state | phase: 2, phase_since: kst_today(), consecutive_clean_days: 0}

        state.phase == 2 and days >= 30 ->
          Logger.info("[AutonomyController] Phase 2 → Phase 3 전환! (#{days}일 연속 마스터 개입 없음)")
          broadcast_phase_change(2, 3)
          %{new_state | phase: 3, phase_since: kst_today(), consecutive_clean_days: 0}

        true ->
          new_state
      end

    save_state_to_db(new_state)

    {:noreply, new_state}
  end

  defp record_master_intervention_event(metadata, cycle_id) do
    meta = normalize_intervention_metadata(metadata)
    subtype = meta |> Map.get("subtype", "decision") |> to_string()
    title = Map.get(meta, "title", "마스터 개입")

    event_metadata =
      meta
      |> Map.drop(["title", "subtype"])
      |> Map.merge(%{"cycle_id" => cycle_id, "trigger" => "new_cycle"})

    Jay.Core.EventLake.record(%{
      event_type: "master.intervention.#{subtype}",
      team: "meta",
      bot_name: "master",
      severity: "info",
      title: title,
      metadata: event_metadata,
      tags: ["master", "intervention", "cycle"]
    })
  rescue
    error ->
      Logger.warning(
        "[AutonomyController] master intervention EventLake 기록 실패: #{inspect(error)}"
      )

      :ok
  end

  defp normalize_intervention_metadata(metadata) when is_map(metadata) do
    Map.new(metadata, fn {key, value} -> {to_string(key), value} end)
  end

  defp normalize_intervention_metadata(_), do: %{}

  defp next_cycle_id do
    case Jay.Core.HubClient.pg_query(
           """
           SELECT COALESCE(MAX((metadata->>'cycle_id')::int), 42) + 1 AS cycle_id
           FROM agent.event_lake
           WHERE metadata->>'cycle_id' IS NOT NULL
           AND metadata->>'cycle_id' ~ '^[0-9]+$'
           """,
           "agent"
         ) do
      {:ok, %{"rows" => [%{"cycle_id" => id}]}} when is_integer(id) -> id
      {:ok, %{"rows" => [%{"cycle_id" => id}]}} -> String.to_integer(to_string(id))
      _ -> 43
    end
  rescue
    _ -> 43
  end

  @impl true
  def handle_info(:daily_check, state) do
    check_and_maybe_advance(state)
    Process.send_after(self(), :daily_check, @check_interval_ms)
    {:noreply, state}
  end

  # ────────────────────────────────────────────────────────────────
  # 단계 전환 로직
  # ────────────────────────────────────────────────────────────────

  defp check_and_maybe_advance(_state) do
    # 오늘 escalation 없으면 clean_day 기록
    escalated_today = escalation_today?()

    unless escalated_today do
      record_clean_day()
    end
  end

  defp escalation_today? do
    today = kst_today() |> Date.to_string()

    case Jay.Core.HubClient.pg_query(
           """
             SELECT COUNT(*)::int AS cnt
             FROM agent.event_lake
             WHERE event_type = 'decision.escalate'
               AND metadata->>'source' = 'jay.decision_engine'
               AND created_at >= (TIMESTAMP '#{today} 00:00:00' AT TIME ZONE 'Asia/Seoul')
               AND created_at < ((TIMESTAMP '#{today} 00:00:00' + INTERVAL '1 day') AT TIME ZONE 'Asia/Seoul')
           """,
           "agent"
         ) do
      {:ok, %{"rows" => [%{"cnt" => n}]}} -> n > 0
      _ -> false
    end
  rescue
    _ -> false
  end

  # ────────────────────────────────────────────────────────────────
  # DB 영속화
  # ────────────────────────────────────────────────────────────────

  defp kv_store_available? do
    with {:ok, _} <-
           Jay.Core.HubClient.pg_query(
             "CREATE SCHEMA IF NOT EXISTS agent",
             "agent"
           ),
         {:ok, _} <-
           Jay.Core.HubClient.pg_query(
             """
               CREATE TABLE IF NOT EXISTS agent.kv_store (
                 key TEXT PRIMARY KEY,
                 value JSONB NOT NULL,
                 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
               )
             """,
             "agent"
           ) do
      true
    else
      _ -> false
    end
  rescue
    _ -> false
  end

  defp load_state_from_db do
    load_state_from_kv()
    |> case do
      {:ok, state} -> state
      :error -> load_state_from_event_lake()
    end
    |> case do
      {:ok, state} -> state
      :error -> load_state_from_legacy_events()
    end
    |> case do
      {:ok, state} -> state
      :error -> default_state()
    end
  rescue
    _ -> default_state()
  end

  defp load_state_from_kv do
    if not kv_store_available?() do
      :error
    else
      with {:ok, %{"rows" => [%{"value" => value}]}} <-
             Jay.Core.HubClient.pg_query(
               """
                 SELECT value FROM agent.kv_store
                 WHERE key = '#{@state_key}'
                 LIMIT 1
               """,
               "agent"
             ),
           {:ok, state} <- state_from_payload(value) do
        {:ok, state}
      else
        _ -> load_legacy_phase_from_kv()
      end
    end
  rescue
    _ -> :error
  end

  defp load_legacy_phase_from_kv do
    with {:ok, %{"rows" => [%{"value" => value}]}} <-
           Jay.Core.HubClient.pg_query(
             """
               SELECT value FROM agent.kv_store
               WHERE key = '#{@phase_key}'
               LIMIT 1
             """,
             "agent"
           ),
         {:ok, phase} <- phase_from_payload(value) do
      {:ok, %__MODULE__{phase: phase, phase_since: kst_today()}}
    else
      _ -> :error
    end
  rescue
    _ -> :error
  end

  defp load_state_from_event_lake do
    with {:ok, %{"rows" => [%{"metadata" => metadata}]}} <-
           Jay.Core.HubClient.pg_query(
             """
               SELECT metadata
               FROM agent.event_lake
               WHERE event_type = '#{@state_event_type}'
                 AND team = 'jay'
                 AND bot_name = 'autonomy_controller'
               ORDER BY created_at DESC, id DESC
               LIMIT 1
             """,
             "agent"
           ),
         {:ok, state} <- state_from_payload(metadata) do
      {:ok, state}
    else
      _ -> :error
    end
  rescue
    _ -> :error
  end

  defp load_state_from_legacy_events do
    with {:ok, %{"rows" => [%{} = row]}} <-
           Jay.Core.HubClient.pg_query(
             """
               WITH latest_phase AS (
                 SELECT
                   COALESCE(metadata->'payload'->>'to', metadata->>'to') AS phase,
                   created_at AS phase_since_at
                 FROM agent.event_lake
                 WHERE event_type = 'autonomy.phase_changed'
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
               ),
               interventions AS (
                 SELECT
                   COUNT(*)::int AS master_intervention_count,
                   MAX(created_at) AS last_escalation_at
                 FROM agent.event_lake
                 WHERE event_type LIKE 'master.intervention.%'
                   AND created_at >= (SELECT phase_since_at FROM latest_phase)
               )
               SELECT
                 latest_phase.phase,
                 latest_phase.phase_since_at,
                 interventions.master_intervention_count,
                 interventions.last_escalation_at
               FROM latest_phase
               CROSS JOIN interventions
             """,
             "agent"
           ) do
      phase = row |> map_get("phase", 1) |> parse_int(1) |> normalize_phase()
      phase_since_at = row |> map_get("phase_since_at") |> parse_datetime()
      last_escalation_at = row |> map_get("last_escalation_at") |> parse_datetime()
      phase_since = kst_date_from_datetime(phase_since_at) || kst_today()
      clean_since = kst_date_from_datetime(last_escalation_at) || phase_since

      {:ok,
       %__MODULE__{
         phase: phase,
         phase_since: phase_since,
         consecutive_clean_days: max(Date.diff(kst_today(), clean_since), 0),
         last_escalation_at: last_escalation_at,
         master_intervention_count:
           row
           |> map_get("master_intervention_count", 0)
           |> parse_int(0)
           |> max(0)
       }}
    else
      _ -> :error
    end
  rescue
    _ -> :error
  end

  defp save_state_to_db(%__MODULE__{} = state) do
    save_state_to_kv(state)
    record_state_snapshot_event(state)
    :ok
  rescue
    _ -> :ok
  end

  defp save_state_to_kv(%__MODULE__{} = state) do
    unless save_state_to_hub_kv(state) do
      save_state_to_repo_kv(state)
    end
  rescue
    _ -> :ok
  end

  defp save_state_to_hub_kv(%__MODULE__{} = state) do
    if kv_store_available?() do
      case Jay.Core.HubClient.pg_query(state_upsert_sql(state), "agent") do
        {:ok, _body} -> true
        _ -> false
      end
    else
      false
    end
  rescue
    _ -> false
  end

  defp save_state_to_repo_kv(%__MODULE__{} = state) do
    ensure_repo_kv_store!()
    Ecto.Adapters.SQL.query!(Jay.Core.Repo, state_upsert_sql(state), [])
    true
  rescue
    _ -> false
  catch
    :exit, _ -> false
  end

  defp ensure_repo_kv_store! do
    Ecto.Adapters.SQL.query!(Jay.Core.Repo, "CREATE SCHEMA IF NOT EXISTS agent", [])

    Ecto.Adapters.SQL.query!(
      Jay.Core.Repo,
      """
        CREATE TABLE IF NOT EXISTS agent.kv_store (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      """,
      []
    )
  end

  defp state_upsert_sql(%__MODULE__{} = state) do
    state_json = state |> persisted_state_payload() |> Jason.encode!() |> sql_quote()
    phase_json = state.phase |> Jason.encode!() |> sql_quote()

    """
      INSERT INTO agent.kv_store (key, value, updated_at)
      VALUES
        ('#{@state_key}', '#{state_json}'::jsonb, NOW()),
        ('#{@phase_key}', '#{phase_json}'::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    """
  end

  defp record_state_snapshot_event(%__MODULE__{} = state) do
    Jay.Core.EventLake.record(%{
      event_type: @state_event_type,
      team: "jay",
      bot_name: "autonomy_controller",
      severity: "info",
      title: "자율화 상태 스냅샷",
      message: "dashboard area 1 autonomy state persisted",
      tags: ["jay", "autonomy", "dashboard", "state"],
      metadata: persisted_state_payload(state)
    })
  rescue
    _ -> :ok
  end

  defp state_from_payload(value) when is_map(value) do
    {:ok,
     %__MODULE__{
       phase: value |> map_get("phase", 1) |> parse_int(1) |> normalize_phase(),
       phase_since:
         value
         |> map_get("phase_since")
         |> parse_date()
         |> Kernel.||(kst_today()),
       consecutive_clean_days:
         value
         |> map_get("consecutive_clean_days", 0)
         |> parse_int(0)
         |> max(0),
       last_escalation_at:
         value
         |> map_get("last_escalation_at")
         |> parse_datetime(),
       master_intervention_count:
         value
         |> map_get("master_intervention_count", 0)
         |> parse_int(0)
         |> max(0)
     }}
  end

  defp state_from_payload(value) when is_binary(value) do
    case Jason.decode(value) do
      {:ok, decoded} -> state_from_payload(decoded)
      _ -> :error
    end
  end

  defp state_from_payload(_), do: :error

  defp phase_from_payload(value) when is_integer(value), do: {:ok, normalize_phase(value)}

  defp phase_from_payload(value) when is_binary(value) do
    case Integer.parse(value) do
      {phase, ""} ->
        {:ok, normalize_phase(phase)}

      _ ->
        case Jason.decode(value) do
          {:ok, decoded} -> phase_from_payload(decoded)
          _ -> :error
        end
    end
  end

  defp phase_from_payload(value) when is_float(value), do: {:ok, normalize_phase(round(value))}
  defp phase_from_payload(_), do: :error

  defp persisted_state_payload(%__MODULE__{} = state) do
    %{
      "phase" => normalize_phase(state.phase),
      "phase_since" => date_to_iso8601(state.phase_since || kst_today()),
      "consecutive_clean_days" => max(parse_int(state.consecutive_clean_days, 0), 0),
      "last_escalation_at" => datetime_to_iso8601(state.last_escalation_at),
      "master_intervention_count" => max(parse_int(state.master_intervention_count, 0), 0),
      "timezone" => "Asia/Seoul",
      "persisted_at" => DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
    }
  end

  defp default_state do
    %__MODULE__{phase: 1, phase_since: kst_today()}
  end

  defp kst_today do
    DateTime.utc_now()
    |> DateTime.add(9 * 60 * 60, :second)
    |> DateTime.to_date()
  end

  defp parse_date(%Date{} = date), do: date

  defp parse_date(value) when is_binary(value) do
    case Date.from_iso8601(value) do
      {:ok, date} -> date
      _ -> nil
    end
  end

  defp parse_date(_), do: nil

  defp parse_datetime(%DateTime{} = datetime), do: datetime

  defp parse_datetime(%NaiveDateTime{} = datetime), do: DateTime.from_naive!(datetime, "Etc/UTC")

  defp parse_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> datetime
      _ -> nil
    end
  end

  defp parse_datetime(_), do: nil

  defp kst_date_from_datetime(%DateTime{} = datetime) do
    datetime
    |> DateTime.add(9 * 60 * 60, :second)
    |> DateTime.to_date()
  end

  defp kst_date_from_datetime(_), do: nil

  defp date_to_iso8601(%Date{} = date), do: Date.to_iso8601(date)
  defp date_to_iso8601(_), do: Date.to_iso8601(kst_today())

  defp datetime_to_iso8601(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_iso8601()
  end

  defp datetime_to_iso8601(_), do: nil

  defp parse_int(value, _default) when is_integer(value), do: value
  defp parse_int(value, _default) when is_float(value), do: round(value)

  defp parse_int(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ -> default
    end
  end

  defp parse_int(_, default), do: default

  defp normalize_phase(phase) when phase in [1, 2, 3], do: phase
  defp normalize_phase(_), do: 1

  defp map_get(map, key, default \\ nil) when is_map(map) do
    Map.get(map, key, Map.get(map, to_string(key), default))
  end

  defp sql_quote(value) when is_binary(value), do: String.replace(value, "'", "''")

  defp broadcast_phase_change(from, to) do
    Jay.Core.HubClient.post_alarm(
      "🤖 [제이] 자율화 단계 전환!\n#{phase_label(from)} → #{phase_label(to)}",
      "jay",
      "autonomy_controller"
    )

    Jay.Core.EventLake.record(%{
      source: "jay.autonomy_controller",
      event_type: "autonomy.phase_changed",
      severity: "info",
      payload: %{from: from, to: to}
    })

    broadcast_dashboard_phase_change(from, to)
  rescue
    _ -> :ok
  end

  defp broadcast_dashboard_phase_change(from, to) do
    case dashboard_pubsub() do
      nil ->
        :ok

      pubsub ->
        Phoenix.PubSub.broadcast(
          pubsub,
          "autonomy:phase_changed",
          {:phase_changed, %{from: from, to: to}}
        )

        Phoenix.PubSub.broadcast(
          pubsub,
          "autonomy_phase_change",
          {:autonomy_phase_change, from, to}
        )
    end
  rescue
    _ -> :ok
  end

  defp dashboard_pubsub do
    Application.get_env(:team_jay, :dashboard_pubsub) ||
      Application.get_env(:jay_core, :dashboard_pubsub)
  end

  defp phase_label(1), do: "Phase 1 감시"
  defp phase_label(2), do: "Phase 2 반자율"
  defp phase_label(3), do: "Phase 3 완전자율"
  defp phase_label(n), do: "Phase #{n}"
end

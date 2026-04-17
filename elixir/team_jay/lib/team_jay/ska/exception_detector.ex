defmodule TeamJay.Ska.ExceptionDetector do
  @moduledoc """
  스카팀 새 예외 케이스 자동 발견 GenServer.

  3가지 방법으로 새 예외 케이스를 탐지한다:

    방법 1: 패턴 비교
      과거 실패 L2 서머리 검색 → 유사 패턴 없으면 새 예외!
      → 텔레그램 "새로운 유형의 실패 감지!"
      → 닥터(클로드팀) 자동 출동 요청

    방법 2: 주기 분석
      failure_cases 시계열 분석 → 실패 발생 주기 계산
      → 예상 변경 임박 시 선제 알림

    방법 3: 교차 패턴
      동시간대 다중 실패 타입 감지 → 복합 원인 탐지
      → "파싱 실패 + API 오류 = 네트워크 문제" 교차 경고

  실패 축적 DB: ska.failure_cases (FailureTracker가 관리)
  새 예외 등록 DB: ska.novel_exceptions
  """

  use GenServer
  require Logger

  alias TeamJay.Ska.PubSub, as: SkaPubSub

  # 패턴 비교 유사도 임계값 (이 이하면 새 예외 케이스!)
  @similarity_threshold 0.50
  # 주기 분석 주기
  @period_check_interval_ms 24 * 60 * 60 * 1_000   # 24시간
  # 교차 패턴 감지 윈도우 (5분 내 N종 이상 에러)
  @cross_pattern_window_ms 5 * 60 * 1_000
  @cross_pattern_types_threshold 3

  defstruct [
    :recent_events,     # 교차 패턴 윈도우용 최근 이벤트
    :known_patterns,    # 메모리 캐시 (novel exception IDs)
    :last_period_check
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "새 예외 패턴 직접 검토 (TeamLead에서 호출)"
  def check_new_pattern(event_type, payload) do
    GenServer.cast(__MODULE__, {:check_pattern, event_type, payload})
  end

  @doc "알려진 예외 목록 조회"
  def get_novel_exceptions(limit \\ 20) do
    GenServer.call(__MODULE__, {:get_exceptions, limit})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[ExceptionDetector] 예외 탐지기 시작")

    SkaPubSub.subscribe(:failure_reported)
    SkaPubSub.subscribe(:selector_deprecated)

    # 24시간마다 주기 분석
    Process.send_after(self(), :period_analysis, @period_check_interval_ms)
    # 시작 후 1분 뒤 DB 테이블 확인
    Process.send_after(self(), :ensure_table, 60_000)

    state = %__MODULE__{
      recent_events: [],
      known_patterns: MapSet.new(),
      last_period_check: nil
    }

    {:ok, state}
  end

  @impl true
  def handle_call({:get_exceptions, limit}, _from, state) do
    rows = fetch_novel_exceptions(limit)
    {:reply, rows, state}
  end

  @impl true
  def handle_cast({:check_pattern, event_type, payload}, state) do
    Task.start(fn -> analyze_new_pattern(event_type, payload) end)
    {:noreply, state}
  end

  # ─── PubSub 핸들링 ───────────────────────────────────────

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    now = DateTime.utc_now()
    error_type = Map.get(payload, :error_type, :unknown)
    agent      = Map.get(payload, :agent, "unknown")
    message    = Map.get(payload, :message, "")

    # 1. 패턴 비교 (unknown 에러만 → 과거 유사 케이스 검색)
    if error_type == :unknown do
      Task.start(fn -> check_unknown_similarity(message, agent, payload) end)
    end

    # 2. 교차 패턴 감지 (5분 윈도우 내 이벤트 누적)
    cutoff = DateTime.add(now, -div(@cross_pattern_window_ms, 1000), :second)
    recent = Enum.filter(state.recent_events, fn %{at: t} ->
      DateTime.compare(t, cutoff) == :gt
    end)
    new_event  = %{at: now, error_type: error_type, agent: agent}
    new_recent = [new_event | recent]

    new_state = %{state | recent_events: new_recent}
    new_state  = check_cross_pattern(new_state)

    {:noreply, new_state}
  end

  @impl true
  def handle_info({:ska_event, :selector_deprecated, payload}, state) do
    target = Map.get(payload, :target, "")
    Task.start(fn ->
      analyze_new_pattern(:selector_deprecated, %{
        target: target,
        message: "셀렉터 폐기: #{target}",
        deprecated_at: DateTime.utc_now() |> DateTime.to_iso8601()
      })
    end)
    {:noreply, state}
  end

  @impl true
  def handle_info(:period_analysis, state) do
    Process.send_after(self(), :period_analysis, @period_check_interval_ms)
    Task.start(fn -> run_period_analysis() end)
    {:noreply, %{state | last_period_check: DateTime.utc_now()}}
  end

  @impl true
  def handle_info(:ensure_table, state) do
    Task.start(fn -> ensure_novel_exceptions_table() end)
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── Private: 방법 1 — 패턴 비교 ─────────────────────────

  defp check_unknown_similarity(message, agent, payload) do
    # 과거 동일 에이전트의 미분류 에러 검색
    sql = """
    SELECT id, error_message, count
    FROM ska.failure_cases
    WHERE error_type = 'unknown'
      AND agent = $1
      AND auto_resolved = FALSE
    ORDER BY last_seen DESC
    LIMIT 10
    """

    case Jay.Core.Repo.query(sql, [agent]) do
      {:ok, %{rows: []}} ->
        # 과거 유사 케이스 없음 → 새 예외!
        register_novel_exception(:new_unknown, message, agent, payload)

      {:ok, %{rows: rows}} ->
        # 간단한 문자열 유사도: 공통 단어 비율 비교
        new_words = tokenize(message)
        similar = Enum.any?(rows, fn [_id, past_msg, _count] ->
          past_words = tokenize(to_string(past_msg))
          jaccard_similarity(new_words, past_words) >= @similarity_threshold
        end)

        unless similar do
          register_novel_exception(:new_unknown, message, agent, payload)
        end

      {:error, _} ->
        :ok
    end
  rescue
    e -> Logger.warning("[ExceptionDetector] check_unknown_similarity 예외: #{inspect(e)}")
  end

  # ─── Private: 방법 2 — 주기 분석 ─────────────────────────

  defp run_period_analysis do
    sql = """
    SELECT error_type,
           COUNT(*) AS total,
           MIN(first_seen) AS earliest,
           MAX(last_seen) AS latest,
           AVG(EXTRACT(EPOCH FROM (last_seen - first_seen))) / 86400.0 AS avg_span_days
    FROM ska.failure_cases
    WHERE first_seen >= NOW() - INTERVAL '90 days'
    GROUP BY error_type
    HAVING COUNT(*) >= 3
    ORDER BY total DESC
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, fn [etype, total, _earliest, _latest, avg_days] ->
          if avg_days && avg_days > 0 do
            cycle_days = Float.round(avg_days, 1)
            Logger.info("[ExceptionDetector] 주기 분석: #{etype} 평균 주기 #{cycle_days}일 (#{total}건)")

            # 마지막 발생일 이후 주기가 임박하면 알림 (80% 도달)
            check_cycle_alert(etype, cycle_days)
          end
        end)

      {:error, err} ->
        Logger.debug("[ExceptionDetector] 주기 분석 DB 조회 실패: #{inspect(err)}")
    end
  rescue
    e -> Logger.warning("[ExceptionDetector] run_period_analysis 예외: #{inspect(e)}")
  end

  defp check_cycle_alert(error_type, cycle_days) do
    sql = """
    SELECT MAX(last_seen) AS last_seen
    FROM ska.failure_cases
    WHERE error_type = $1
    """

    case Jay.Core.Repo.query(sql, [to_string(error_type)]) do
      {:ok, %{rows: [[last_seen]]}} when not is_nil(last_seen) ->
        days_since = DateTime.diff(DateTime.utc_now(), last_seen, :second) / 86400.0
        ratio = days_since / cycle_days

        if ratio >= 0.80 do
          msg = "⚠️ [스카팀] #{error_type} 재발 임박!\n주기: #{cycle_days}일 / 마지막 발생: #{Float.round(days_since, 1)}일 전\n→ 선제 모니터링 강화"
          Logger.warning("[ExceptionDetector] #{msg}")
          Task.start(fn ->
            Jay.Core.HubClient.post_alarm(msg, "ska", "exception_detector")
          end)
        end

      _ -> :ok
    end
  rescue
    _ -> :ok
  end

  # ─── Private: 방법 3 — 교차 패턴 ─────────────────────────

  defp check_cross_pattern(state) do
    types_in_window = state.recent_events
                      |> Enum.map(& &1.error_type)
                      |> Enum.uniq()
                      |> length()

    if types_in_window >= @cross_pattern_types_threshold do
      type_list = state.recent_events
                  |> Enum.map(& &1.error_type)
                  |> Enum.frequencies()
                  |> Enum.map(fn {t, n} -> "#{t}×#{n}" end)
                  |> Enum.join(", ")

      msg = "🔀 [스카팀] 복합 오류 패턴 감지 (5분 내 #{types_in_window}종)\n#{type_list}\n→ 네트워크/인프라 점검 권장"
      Logger.warning("[ExceptionDetector] #{msg}")

      Task.start(fn ->
        Jay.Core.HubClient.post_alarm(msg, "ska", "exception_detector")
        Jay.Core.EventLake.record(%{
          event_type: "ska_cross_pattern_detected",
          team: "ska",
          bot_name: "exception_detector",
          severity: "warning",
          title: "복합 오류 패턴",
          message: msg,
          tags: ["exception_detector", "cross_pattern"],
          metadata: %{types_count: types_in_window, type_list: type_list}
        })
      end)

      # 감지 후 윈도우 초기화 (중복 알림 방지)
      %{state | recent_events: []}
    else
      state
    end
  end

  # ─── Private: 새 예외 케이스 등록 ────────────────────────

  defp analyze_new_pattern(event_type, payload) do
    message = Map.get(payload, :message, inspect(payload))
    agent   = Map.get(payload, :agent, "unknown")
    register_novel_exception(event_type, message, agent, payload)
  end

  defp register_novel_exception(event_type, message, agent, payload) do
    sql = """
    INSERT INTO ska.novel_exceptions
      (event_type, description, agent, first_seen, last_seen, metadata)
    VALUES ($1, $2, $3, NOW(), NOW(), $4::jsonb)
    ON CONFLICT (agent, md5(description))
    DO UPDATE SET
      last_seen = NOW(),
      occurrence_count = ska.novel_exceptions.occurrence_count + 1
    RETURNING id, occurrence_count
    """

    meta_json = Jason.encode!(sanitize_metadata(payload))

    case Jay.Core.Repo.query(sql, [to_string(event_type), String.slice(message, 0, 500), agent, meta_json]) do
      {:ok, %{rows: [[id, 1]]}} ->
        Logger.warning("[ExceptionDetector] 🆕 새 예외 케이스 등록! id=#{id} type=#{event_type} agent=#{agent}")
        notify_new_exception(event_type, message, agent, id)

      {:ok, %{rows: [[_id, count]]}} ->
        Logger.debug("[ExceptionDetector] 기존 예외 누적: count=#{count}")

      {:error, err} ->
        Logger.debug("[ExceptionDetector] novel_exceptions 저장 실패: #{inspect(err)}")
    end
  rescue
    e -> Logger.warning("[ExceptionDetector] register_novel_exception 예외: #{inspect(e)}")
  end

  defp notify_new_exception(event_type, message, agent, id) do
    msg = "🆕 [스카팀] 새로운 예외 유형 발견!\nID: #{id}\n유형: #{event_type}\n에이전트: #{agent}\n내용: #{String.slice(message, 0, 150)}"
    Jay.Core.HubClient.post_alarm(msg, "ska", "exception_detector")
    Jay.Core.EventLake.record(%{
      event_type: "ska_novel_exception",
      team: "ska",
      bot_name: "exception_detector",
      severity: "warning",
      title: "새 예외 케이스: #{event_type}",
      message: msg,
      tags: ["exception_detector", "novel", to_string(event_type)],
      metadata: %{exception_id: id, agent: agent, event_type: to_string(event_type)}
    })
  end

  # ─── Private: DB 조회/유틸 ───────────────────────────────

  defp fetch_novel_exceptions(limit) do
    sql = """
    SELECT id, event_type, description, agent, first_seen, last_seen, occurrence_count
    FROM ska.novel_exceptions
    ORDER BY last_seen DESC
    LIMIT $1
    """
    case Jay.Core.Repo.query(sql, [limit]) do
      {:ok, %{rows: rows, columns: cols}} ->
        keys = Enum.map(cols, &String.to_atom/1)
        Enum.map(rows, &Enum.zip(keys, &1) |> Map.new())
      {:error, _} -> []
    end
  rescue
    _ -> []
  end

  defp ensure_novel_exceptions_table do
    sql = """
    CREATE TABLE IF NOT EXISTS ska.novel_exceptions (
      id               BIGSERIAL PRIMARY KEY,
      event_type       VARCHAR(50) NOT NULL,
      description      TEXT NOT NULL,
      agent            VARCHAR(50) NOT NULL DEFAULT 'unknown',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata         JSONB NOT NULL DEFAULT '{}'::jsonb
    )
    """

    idx_sql = """
    CREATE UNIQUE INDEX IF NOT EXISTS ska_novel_exceptions_uniq_idx
    ON ska.novel_exceptions (agent, md5(description))
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, _} ->
        Jay.Core.Repo.query(idx_sql, [])
        Logger.debug("[ExceptionDetector] ska.novel_exceptions 테이블 확인 완료")
      {:error, err} ->
        Logger.warning("[ExceptionDetector] 테이블 생성 실패: #{inspect(err)}")
    end
  rescue
    e -> Logger.warning("[ExceptionDetector] ensure_table 예외: #{inspect(e)}")
  end

  defp tokenize(text) do
    text
    |> String.downcase()
    |> String.split(~r/[\s\.,;:!?()\[\]{}\-_\/\\]+/)
    |> Enum.filter(&(String.length(&1) > 2))
    |> MapSet.new()
  end

  defp jaccard_similarity(set_a, set_b) do
    intersection = MapSet.intersection(set_a, set_b) |> MapSet.size()
    union        = MapSet.union(set_a, set_b) |> MapSet.size()
    if union > 0, do: intersection / union, else: 0.0
  end

  defp sanitize_metadata(map) when is_map(map) do
    Map.new(map, fn {k, v} ->
      {to_string(k), sanitize_value(v)}
    end)
  end
  defp sanitize_metadata(v), do: %{value: inspect(v)}

  defp sanitize_value(v) when is_binary(v), do: String.slice(v, 0, 300)
  defp sanitize_value(v) when is_atom(v),   do: Atom.to_string(v)
  defp sanitize_value(v) when is_number(v), do: v
  defp sanitize_value(v) when is_boolean(v), do: v
  defp sanitize_value(v) when is_nil(v),    do: nil
  defp sanitize_value(v) when is_map(v),    do: sanitize_metadata(v)
  defp sanitize_value(v) when is_list(v),   do: Enum.map(v, &sanitize_value/1)
  defp sanitize_value(v),                   do: inspect(v) |> String.slice(0, 200)
end

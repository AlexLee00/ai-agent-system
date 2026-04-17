defmodule TeamJay.Blog.PublishGuard do
  @moduledoc """
  블로그 발행 파이프라인 보호 GenServer.

  담당:
    - 발행 실패 → 재시도 3회 (지수 백오프)
    - 재시도 모두 실패 → 큐에 저장 → 복구 시 재발행
    - 이미지 업로드 실패 → GitHub Pages 폴백 적용
    - 발행 큐 오래된 항목(24h+) → 만료 처리 + 알림
    - JayBus :blog_publish_failed 이벤트 수신

  큐 구조: :ets 기반 인메모리 (재시작 시 초기화)
  """

  use GenServer
  require Logger
  alias Jay.V2.Topics

  @max_retries 3
  @retry_base_ms 60_000      # 1분 베이스
  @queue_expire_ms 24 * 60 * 60 * 1_000   # 24시간 후 만료
  @poll_interval_ms 5 * 60 * 1_000        # 5분마다 큐 체크

  defstruct [
    queue: [],          # [{id, item, retries, queued_at}]
    processing: false,
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "발행 실패 항목을 재시도 큐에 추가"
  def enqueue(item) do
    GenServer.cast(__MODULE__, {:enqueue, item})
  end

  @doc "큐 현황 조회"
  def queue_status do
    GenServer.call(__MODULE__, :queue_status)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[PublishGuard] 발행 파이프라인 보호 서비스 시작")
    Topics.subscribe(:blog_publish_failed)
    Process.send_after(self(), :poll_queue, @poll_interval_ms)
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast({:enqueue, item}, state) do
    entry = %{
      id: :erlang.unique_integer([:positive]),
      item: item,
      retries: 0,
      queued_at: System.monotonic_time(:millisecond),
      next_retry_at: System.monotonic_time(:millisecond) + @retry_base_ms
    }
    Logger.info("[PublishGuard] 발행 큐 추가: #{inspect(item[:title] || item[:type] || "unknown")}")
    {:noreply, %{state | queue: [entry | state.queue]}}
  end

  @impl true
  def handle_call(:queue_status, _from, state) do
    {:reply, %{queue_size: length(state.queue), items: state.queue}, state}
  end

  # JayBus 이벤트 수신
  @impl true
  def handle_info({:jay_bus, :blog_publish_failed, payload}, state) do
    Logger.warning("[PublishGuard] 발행 실패 이벤트 수신: #{inspect(payload[:reason])}")
    entry = %{
      id: :erlang.unique_integer([:positive]),
      item: payload,
      retries: 0,
      queued_at: System.monotonic_time(:millisecond),
      next_retry_at: System.monotonic_time(:millisecond) + @retry_base_ms
    }
    {:noreply, %{state | queue: [entry | state.queue]}}
  end

  @impl true
  def handle_info(:poll_queue, state) do
    new_state = process_queue(state)
    Process.send_after(self(), :poll_queue, @poll_interval_ms)
    {:noreply, new_state}
  end

  @impl true
  def handle_info({:retry, entry_id}, state) do
    new_state = retry_entry(entry_id, state)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 큐 처리 ─────────────────────────────────────────────

  defp process_queue(state) do
    now = System.monotonic_time(:millisecond)

    # 만료된 항목 제거
    {expired, active} = Enum.split_with(state.queue, fn e ->
      now - e.queued_at > @queue_expire_ms
    end)

    unless Enum.empty?(expired) do
      Logger.warning("[PublishGuard] 만료된 큐 항목 #{length(expired)}건 폐기")
      Enum.each(expired, fn e ->
        notify_expired(e.item)
      end)
    end

    # 재시도 가능한 항목 스케줄링
    ready = Enum.filter(active, fn e -> now >= e.next_retry_at end)
    Enum.each(ready, fn e ->
      Process.send_after(self(), {:retry, e.id}, 100)
    end)

    %{state | queue: active}
  end

  defp retry_entry(entry_id, state) do
    case Enum.find(state.queue, fn e -> e.id == entry_id end) do
      nil ->
        state

      entry ->
        Logger.info("[PublishGuard] 재시도 #{entry.retries + 1}/#{@max_retries}: #{inspect(entry.item[:title] || "unknown")}")

        case attempt_publish(entry.item) do
          :ok ->
            Logger.info("[PublishGuard] ✅ 재시도 성공!")
            broadcast_recovered(entry.item)
            %{state | queue: Enum.reject(state.queue, fn e -> e.id == entry_id end)}

          :error when entry.retries + 1 >= @max_retries ->
            Logger.error("[PublishGuard] ❌ 재시도 #{@max_retries}회 모두 실패 — 포기")
            notify_max_retries(entry.item)
            %{state | queue: Enum.reject(state.queue, fn e -> e.id == entry_id end)}

          :error ->
            next_delay = @retry_base_ms * :math.pow(2, entry.retries) |> round()
            updated = %{entry |
              retries: entry.retries + 1,
              next_retry_at: System.monotonic_time(:millisecond) + next_delay
            }
            Logger.info("[PublishGuard] 다음 재시도: #{div(next_delay, 60_000)}분 후")
            %{state | queue: Enum.map(state.queue, fn e ->
              if e.id == entry_id, do: updated, else: e
            end)}
        end
    end
  end

  # ─── 발행 시도 ────────────────────────────────────────────

  # post_id를 pending 상태로 재설정 → 다음 run-daily.ts 실행 시 자동 재처리.
  # run-daily.ts는 단일 전체 플로우이므로 직접 호출 대신 DB 상태 조작으로 재진입.
  defp attempt_publish(item) do
    post_id = item[:post_id]

    if post_id do
      result = Jay.Core.HubClient.pg_query("""
        UPDATE blog.posts
        SET status = 'pending', updated_at = NOW()
        WHERE id = #{post_id}
          AND status IN ('failed', 'error', 'publish_failed')
        RETURNING id
      """, "blog")

      case result do
        {:ok, %{"rows" => [_|_]}} ->
          Logger.info("[PublishGuard] post_id=#{post_id} → pending 재설정 완료 (다음 run-daily 실행 시 재처리)")
          :ok
        {:ok, %{"rows" => []}} ->
          Logger.warning("[PublishGuard] post_id=#{post_id} — 상태 조건 불충족 (이미 처리됨 또는 없음)")
          :error
        _ ->
          :error
      end
    else
      :error
    end
  end

  # ─── JayBus & 알림 ───────────────────────────────────────

  defp broadcast_recovered(item) do
    Topics.broadcast(:blog_publish_recovered, %{
      item: item,
      recovered_at: DateTime.utc_now()
    })
  rescue
    _ -> :ok
  end

  defp notify_expired(item) do
    Jay.Core.HubClient.post_alarm(
      "[블로팀] 발행 재시도 만료 (24h): #{inspect(item[:title] || "unknown")}",
      "blog",
      "publish_guard"
    )
  rescue
    _ -> :ok
  end

  defp notify_max_retries(item) do
    Jay.Core.HubClient.post_alarm(
      "[블로팀 CRITICAL] 발행 #{@max_retries}회 재시도 실패: #{inspect(item[:title] || "unknown")}",
      "blog",
      "publish_guard"
    )
  rescue
    _ -> :ok
  end
end

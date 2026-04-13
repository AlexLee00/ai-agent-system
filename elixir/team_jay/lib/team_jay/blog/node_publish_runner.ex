defmodule TeamJay.Blog.NodePublishRunner do
  @moduledoc """
  블로그팀 Node verify/dry-run handoff 실행기 스캐폴드.

  `execution:node_publish` 이벤트를 받아 실제 Node 런타임의
  `run-daily --verify --json`를 먼저 실행하고,
  검증이 통과하면 `run-daily --dry-run --json`까지 이어서 실행한다.

  운영 발행을 직접 수행하지 않고 dry-run까지 연결해서
  Elixir Phase 1 파이프라인의 안전한 end-to-end 검증에 집중한다.
  """

  use GenServer
  require Logger

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  @verify_timeout_ms 45_000
  @dry_run_timeout_ms 90_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(Topics.execution("node_publish"))

    {:ok,
     %{
       run_count: 0,
       ok_count: 0,
       dry_run_ok_count: 0,
       inflight: %{},
       last_run_at: nil,
       last_results: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       run_count: state.run_count,
       ok_count: state.ok_count,
       dry_run_ok_count: state.dry_run_ok_count,
       inflight_count: map_size(state.inflight),
       inflight:
         Enum.map(state.inflight, fn {_ref, item} ->
           %{
             post_type: get_in(item, [:execution, :payload, :post_type]),
             writer: get_in(item, [:execution, :payload, :writer]),
             date: get_in(item, [:execution, :payload, :date]),
             started_at: item.started_at
           }
         end),
       last_run_at: state.last_run_at,
       last_results: state.last_results
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:execution_ready, "node_publish", execution}}, state) do
    Logger.info(
      "[blog-node-publish-runner] start post_type=#{get_in(execution, [:payload, :post_type])} writer=#{get_in(execution, [:payload, :writer])} date=#{get_in(execution, [:payload, :date])}"
    )

    task =
      Task.async(fn ->
        {:execution_result, execution, run_verify_and_dry_run(execution)}
      end)

    {:noreply,
     %{
       state
       | inflight:
           Map.put(state.inflight, task.ref, %{execution: execution, started_at: DateTime.utc_now()})
     }}
  end

  @impl true
  def handle_info({ref, {:execution_result, _execution, result}}, state) do
    case Map.pop(state.inflight, ref) do
      {nil, _inflight} ->
        {:noreply, state}

      {_entry, inflight} ->
        Process.demonitor(ref, [:flush])
        Logger.info(
          "[blog-node-publish-runner] finish status=#{result.run_status} ok=#{result.ok} dry_run_ok=#{result.dry_run_ok} duration_ms=#{Map.get(result, :duration_ms)}"
        )
        :ok = PubSub.broadcast_execution_result("node_publish", result)

        {:noreply,
         %{
           state
           | inflight: inflight,
             run_count: state.run_count + 1,
             ok_count: state.ok_count + if(result.ok, do: 1, else: 0),
             dry_run_ok_count: state.dry_run_ok_count + if(result.dry_run_ok, do: 1, else: 0),
             last_run_at: DateTime.utc_now(),
             last_results: [result | Enum.take(state.last_results, 4)]
         }}
    end
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    case Map.pop(state.inflight, ref) do
      {nil, _inflight} ->
        {:noreply, state}

      {%{execution: execution}, inflight} ->
        result = build_task_failure_result(execution, reason)
        :ok = PubSub.broadcast_execution_result("node_publish", result)

        {:noreply,
         %{
           state
           | inflight: inflight,
             run_count: state.run_count + 1,
             last_run_at: DateTime.utc_now(),
             last_results: [result | Enum.take(state.last_results, 4)]
         }}
    end
  end

  defp run_verify_and_dry_run(execution) do
    started_at = System.monotonic_time(:millisecond)
    env = Map.get(execution, :env, [])

    verify_started_at = System.monotonic_time(:millisecond)

    {verify_output, verify_exit_code, verify_status} =
      run_command(
        execution.command,
        execution.args,
        env,
        @verify_timeout_ms
      )

    verify_finished_at = System.monotonic_time(:millisecond)
    verify_duration_ms = verify_finished_at - verify_started_at

    dry_run_args = build_dry_run_args(execution.args)

    dry_run_started_at = System.monotonic_time(:millisecond)

    {dry_run_output, dry_run_exit_code, dry_run_status} =
      if verify_exit_code == 0 do
        run_command(
          execution.command,
          dry_run_args,
          build_dry_run_env(env),
          @dry_run_timeout_ms
        )
      else
        {"verify_failed", nil, :skipped}
      end

    dry_run_finished_at = System.monotonic_time(:millisecond)
    dry_run_duration_ms =
      if dry_run_status == :skipped do
        0
      else
        dry_run_finished_at - dry_run_started_at
      end

    finished_at = System.monotonic_time(:millisecond)

    %{
      target: "node_publish",
      run_status:
        cond do
          verify_status == :timeout -> :verify_timeout
          verify_exit_code != 0 -> :verify_failed
          dry_run_status == :timeout -> :dry_run_timeout
          dry_run_exit_code == 0 -> :dry_run_verified
          true -> :dry_run_failed
        end,
      ok: verify_exit_code == 0,
      dry_run_ok: dry_run_exit_code == 0,
      exit_code: verify_exit_code,
      dry_run_exit_code: dry_run_exit_code,
      verify_status: verify_status,
      dry_run_status: dry_run_status,
      verify_timeout_ms: @verify_timeout_ms,
      dry_run_timeout_ms: @dry_run_timeout_ms,
      verify_duration_ms: verify_duration_ms,
      dry_run_duration_ms: dry_run_duration_ms,
      command: execution.command,
      args: execution.args,
      dry_run_args: dry_run_args,
      env: env,
      output_preview: String.slice(verify_output || "", 0, 800),
      dry_run_output_preview: String.slice(dry_run_output || "", 0, 800),
      started_at: DateTime.utc_now() |> DateTime.add(-(finished_at - started_at), :millisecond),
      finished_at: DateTime.utc_now(),
      duration_ms: finished_at - started_at,
      payload: execution.payload
    }
  rescue
    error ->
      %{
        target: "node_publish",
        run_status: :failed,
        ok: false,
        dry_run_ok: false,
        exit_code: nil,
        dry_run_exit_code: nil,
        command: execution.command,
        args: execution.args,
        dry_run_args: build_dry_run_args(execution.args),
        env: Map.get(execution, :env, []),
        output_preview: Exception.message(error),
        dry_run_output_preview: "",
        finished_at: DateTime.utc_now(),
        duration_ms: 0,
        payload: execution.payload
      }
  end

  defp run_command(command, args, env, timeout_ms) do
    task =
      Task.async(fn ->
        System.cmd(
          command,
          args,
          env: env,
          stderr_to_stdout: true
        )
      end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, {output, exit_code}} ->
        {output, exit_code, :ok}

      nil ->
        {"command_timeout after #{timeout_ms}ms", nil, :timeout}
    end
  end

  defp build_task_failure_result(execution, reason) do
    %{
      target: "node_publish",
      run_status: :task_failed,
      ok: false,
      dry_run_ok: false,
      exit_code: nil,
      dry_run_exit_code: nil,
      command: execution.command,
      args: execution.args,
      dry_run_args: build_dry_run_args(execution.args),
      env: Map.get(execution, :env, []),
      output_preview: "task_down: #{inspect(reason)}",
      dry_run_output_preview: "",
      finished_at: DateTime.utc_now(),
      duration_ms: 0,
      payload: execution.payload
    }
  end

  defp build_dry_run_args(args) do
    args
    |> Enum.reject(&(&1 == "--verify"))
    |> Enum.reject(&(&1 == "--dry-run"))
    |> then(fn base -> List.insert_at(base, -1, "--dry-run") end)
  end

  defp build_dry_run_env(env) do
    [{"BLOG_PHASE1_FAST_DRY_RUN", "1"} | Enum.reject(env, fn {key, _value} -> key == "BLOG_PHASE1_FAST_DRY_RUN" end)]
  end
end

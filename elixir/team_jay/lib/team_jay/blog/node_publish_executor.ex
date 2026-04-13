defmodule TeamJay.Blog.NodePublishExecutor do
  @moduledoc """
  블로그팀 Node publish 실행기 스캐폴드.

  `handoff:node_publish` 이벤트를 받아 실제 Node 런타임 실행 직전의
  execution payload를 만든다.

  현재는 실제 Port/OS 프로세스 실행 없이, 실행 직전 상태만 고정하고
  후속 execution 이벤트를 발행한다.
  """

  use GenServer

  alias TeamJay.Blog.PubSub
  alias TeamJay.Blog.Topics

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(Topics.handoff("node_publish"))

    {:ok,
     %{
       executed_count: 0,
       last_executed_at: nil,
       last_items: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       executed_count: state.executed_count,
       last_executed_at: state.last_executed_at,
       last_items: state.last_items
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:handoff_ready, "node_publish", handoff}}, state) do
    execution = build_execution(handoff)
    :ok = PubSub.broadcast_execution("node_publish", execution)

    {:noreply,
     %{
       state
       | executed_count: state.executed_count + 1,
         last_executed_at: DateTime.utc_now(),
         last_items: [execution | Enum.take(state.last_items, 4)]
     }}
  end

  defp build_execution(handoff) do
    %{
      target: "node_publish",
      execution_status: :prepared,
      execution_note: "Phase 1 node publish executor prepared verify handoff",
      command: handoff.command,
      args: build_verify_args(handoff.args),
      env: build_env(handoff.payload),
      payload: handoff.payload
    }
  end

  defp build_verify_args([script | rest]) do
    base =
      rest
      |> Enum.reject(&(&1 == "--json"))

    [script, "--verify", "--json" | base]
  end

  defp build_verify_args(args), do: args

  defp build_env(payload) do
    [
      {"BLOG_RUN_DATE", to_string(payload.date)},
      {"BLOG_ELIXIR_PHASE", "1"}
    ]
  end
end

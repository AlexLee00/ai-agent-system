defmodule TeamJay.Blog.FacebookRunner do
  @moduledoc """
  블로그팀 Facebook 채널 실행 러너 스캐폴드.

  `execution:facebook` 이벤트를 받아 실제 페이지 게시 직전 단계의
  가벼운 실행 결과를 만든다.
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
    {:ok, _ref} = PubSub.subscribe(Topics.execution("facebook"))

    {:ok,
     %{
       run_count: 0,
       ok_count: 0,
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
       last_run_at: state.last_run_at,
       last_results: state.last_results
     }, state}
  end

  @impl true
  def handle_info({:blog_event, _topic, {:execution_ready, "facebook", execution}}, state) do
    result = run_execution(execution)
    :ok = PubSub.broadcast_execution_result("facebook", result)

    {:noreply,
     %{
       state
       | run_count: state.run_count + 1,
         ok_count: state.ok_count + if(result.ok, do: 1, else: 0),
         last_run_at: DateTime.utc_now(),
         last_results: [result | Enum.take(state.last_results, 4)]
     }}
  end

  defp run_execution(execution) do
    payload = Map.get(execution, :payload, %{})

    %{
      target: "facebook",
      run_status: :relay_prepared,
      ok: true,
      exit_code: 0,
      message: Map.get(execution, :message),
      link: Map.get(execution, :link),
      channel: "facebook",
      finished_at: DateTime.utc_now(),
      duration_ms: 20,
      payload: payload
    }
  end
end

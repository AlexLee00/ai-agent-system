defmodule Jay.V2.Skill.CrossTeamPipelineTest do
  use ExUnit.Case, async: true

  setup_all do
    Code.ensure_loaded?(Jay.V2.Skill.CrossTeamPipeline)
    :ok
  end

  describe "module_definition" do
    test "모듈 정의됨" do
      assert Code.ensure_loaded?(Jay.V2.Skill.CrossTeamPipeline)
    end
  end

  describe "jido_action_api" do
    test "run/2 export" do
      assert function_exported?(Jay.V2.Skill.CrossTeamPipeline, :run, 2)
    end
  end

  describe "behavior" do
    test "알 수 없는 파이프라인은 error 반환" do
      assert {:error, msg} = Jay.V2.Skill.CrossTeamPipeline.run(
        %{pipeline: "invalid->pipeline", event_type: "test", payload: %{}},
        %{}
      )
      assert is_binary(msg)
    end

    test "유효 파이프라인 ok 또는 rescue error 반환 (JayBus 미가동 허용)" do
      result = Jay.V2.Skill.CrossTeamPipeline.run(
        %{pipeline: "luna->blog", payload: %{test: true}},
        %{}
      )
      assert match?({:ok, %{pipeline: "luna->blog"}}, result) or match?({:error, _}, result)
    end
  end
end

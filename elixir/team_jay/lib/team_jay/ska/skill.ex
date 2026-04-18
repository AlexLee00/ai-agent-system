defmodule TeamJay.Ska.Skill do
  @moduledoc """
  스카팀 스킬 공통 Behaviour.

  모든 스킬은 이 behaviour를 구현하거나 use Jido.Action 사용.

  계약:
    run/2     — 실제 체크 루틴 실행
    metadata/0 — 스킬 메타데이터 (이름/도메인/버전)
    health_check/0 — 스킬 자체 정상성 확인 (optional)
  """

  @callback run(params :: map(), context :: map()) ::
              {:ok, result :: any()} | {:error, reason :: term()}

  @callback metadata() :: %{
              name: atom(),
              domain: atom(),
              version: String.t(),
              description: String.t(),
              input_schema: map(),
              output_schema: map()
            }

  @callback health_check() :: :ok | {:error, reason :: term()}

  @optional_callbacks [health_check: 0]
end

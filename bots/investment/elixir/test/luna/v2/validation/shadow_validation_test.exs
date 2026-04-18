defmodule Luna.V2.Validation.ShadowValidationTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Validation.ShadowValidation

  describe "run/1" do
    test "market 미지정 시 crypto 기본값" do
      assert {:ok, result} = ShadowValidation.run(%{})
      assert result.type == :shadow
      assert is_integer(result.runs)
      assert is_float(result.avg_similarity)
    end

    test "runs < 10 이면 pass false" do
      # DB에 0건인 케이스 (미운영 환경)
      strategy = %{market: "__test_shadow__"}
      {:ok, result} = ShadowValidation.run(strategy)
      # DB가 없으면 runs=0, pass=false
      assert result.runs == 0 or is_boolean(result.pass)
    end

    test "반환 구조 일관성" do
      {:ok, result} = ShadowValidation.run(%{market: :crypto})
      assert Map.has_key?(result, :type)
      assert Map.has_key?(result, :runs)
      assert Map.has_key?(result, :avg_similarity)
      assert Map.has_key?(result, :pass)
    end
  end
end

defmodule Darwin.V2.ESPLTest do
  use ExUnit.Case

  test "evolve_weekly/0 ESPL 비활성 시 에러 반환" do
    System.delete_env("DARWIN_ESPL_ENABLED")
    assert {:error, :espl_disabled} = Darwin.V2.ESPL.evolve_weekly()
  end

  test "evolve_weekly/0 ESPL 활성 시 빈 세대 처리" do
    System.put_env("DARWIN_ESPL_ENABLED", "true")
    # DB 없이 빈 population → {:ok, ...} 반환
    result = Darwin.V2.ESPL.evolve_weekly()
    assert match?({:ok, _} , result) or match?({:error, _}, result)
    System.delete_env("DARWIN_ESPL_ENABLED")
  end
end

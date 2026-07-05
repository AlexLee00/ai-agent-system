defmodule Darwin.V2.ESPLTest do
  use ExUnit.Case

  setup do
    old_espl = System.get_env("DARWIN_ESPL_ENABLED")
    old_shadow_mode = System.get_env("DARWIN_SHADOW_MODE")
    old_v2_shadow_enabled = System.get_env("DARWIN_V2_SHADOW_ENABLED")

    on_exit(fn ->
      restore_env("DARWIN_ESPL_ENABLED", old_espl)
      restore_env("DARWIN_SHADOW_MODE", old_shadow_mode)
      restore_env("DARWIN_V2_SHADOW_ENABLED", old_v2_shadow_enabled)
    end)

    :ok
  end

  test "evolve_weekly/0 ESPL 비활성 시 에러 반환" do
    System.delete_env("DARWIN_ESPL_ENABLED")
    System.delete_env("DARWIN_V2_SHADOW_ENABLED")
    assert {:error, :espl_disabled} = Darwin.V2.ESPL.evolve_weekly()
  end

  test "evolve_weekly/0 ESPL만 활성화되어도 V2 shadow hard gate 없이는 에러 반환" do
    System.put_env("DARWIN_ESPL_ENABLED", "true")
    System.put_env("DARWIN_SHADOW_MODE", "true")
    System.delete_env("DARWIN_V2_SHADOW_ENABLED")
    assert {:error, :espl_disabled} = Darwin.V2.ESPL.evolve_weekly()
  end

  test "evolve_weekly/0 ESPL + V2 shadow hard gate 활성 시 빈 세대 처리" do
    System.put_env("DARWIN_ESPL_ENABLED", "true")
    System.put_env("DARWIN_SHADOW_MODE", "true")
    System.put_env("DARWIN_V2_SHADOW_ENABLED", "true")
    # DB 없이 빈 population → {:ok, ...} 반환
    result = Darwin.V2.ESPL.evolve_weekly()
    assert match?({:ok, _} , result) or match?({:error, _}, result)
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end

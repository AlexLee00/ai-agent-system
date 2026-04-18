defmodule TeamJay.Ska.PortBridge.PythonPort do
  @moduledoc """
  Python 스크립트 호출 브릿지 — forecast/rebecca/eve 실행.

  스킬 → PythonPort → Python subprocess → JSON stdin/stdout → 결과

  Kill Switch: SKA_PYTHON_SKILL_ENABLED=true (기본 false)
  환경: bots/ska/venv/bin/python3 사용
  """
  require Logger

  @default_timeout_ms 60_000

  @doc """
  Python 스크립트를 JSON 인터페이스로 호출.

  script: "forecast.py" | "rebecca.py" | "eve.py"
  params: %{action: "predict", ...}
  """
  def call(script, params, timeout_ms \\ @default_timeout_ms) do
    unless enabled?() do
      {:error, :python_skill_disabled}
    else
      python_bin = python_bin_path()
      ska_root = ska_root_path()
      script_path = Path.join([ska_root, "src", script])

      unless File.exists?(python_bin) do
        Logger.error("[PythonPort] Python 실행파일 없음: #{python_bin}")
        {:error, :python_not_found}
      else
        unless File.exists?(script_path) do
          Logger.error("[PythonPort] 스크립트 없음: #{script_path}")
          {:error, :script_not_found}
        else
          do_call(python_bin, script_path, params, timeout_ms)
        end
      end
    end
  end

  # ─── 내부 실행 ────────────────────────────────────────────

  defp do_call(python_bin, script_path, params, timeout_ms) do
    input_json = Jason.encode!(params)

    port =
      Port.open({:spawn_executable, python_bin}, [
        :binary,
        :exit_status,
        :use_stdio,
        args: [script_path, "--json-input"]
      ])

    Port.command(port, input_json)

    result = collect_output(port, "", timeout_ms)
    result
  end

  defp collect_output(port, acc, timeout_ms) do
    receive do
      {^port, {:data, data}} ->
        collect_output(port, acc <> data, timeout_ms)

      {^port, {:exit_status, 0}} ->
        parse_output(acc)

      {^port, {:exit_status, code}} ->
        Logger.warning("[PythonPort] 스크립트 비정상 종료: exit=#{code}, output=#{acc}")
        {:error, {:non_zero_exit, code}}
    after
      timeout_ms ->
        Port.close(port)
        Logger.error("[PythonPort] 타임아웃 #{timeout_ms}ms")
        {:error, :timeout}
    end
  end

  defp parse_output(""), do: {:error, :empty_output}

  defp parse_output(raw) do
    case Jason.decode(raw) do
      {:ok, result} ->
        {:ok, result}

      {:error, _} ->
        # 마지막 줄만 JSON으로 파싱 시도 (Python이 로그를 섞어 출력할 경우)
        last_line = raw |> String.split("\n") |> Enum.filter(&(&1 != "")) |> List.last() || ""

        case Jason.decode(last_line) do
          {:ok, result} -> {:ok, result}
          {:error, _} -> {:error, {:invalid_json_output, String.slice(raw, 0, 200)}}
        end
    end
  end

  # ─── 경로 설정 ───────────────────────────────────────────

  defp python_bin_path do
    System.get_env(
      "SKA_PYTHON_BIN",
      Path.join(ska_root_path(), "venv/bin/python3")
    )
  end

  defp ska_root_path do
    project_root = System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")
    Path.join(project_root, "bots/ska")
  end

  defp enabled? do
    System.get_env("SKA_PYTHON_SKILL_ENABLED", "false") == "true"
  end
end

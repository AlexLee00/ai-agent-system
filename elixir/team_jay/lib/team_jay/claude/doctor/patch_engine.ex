defmodule TeamJay.Claude.Doctor.PatchEngine do
  @moduledoc """
  닥터 패치 엔진 — LLM 기반 코드 수정 생성

  에러 정보 + 파일 내용 → Hub LLM(로컬) → 수정 코드 생성
  Level 1↑에서 활성화. 현재는 제안 텍스트만 생성.

  비용: Hub LLM 로컬 모델 ($0)
  """

  require Logger

  @project_root System.get_env("PROJECT_ROOT", "/Users/alexlee/projects/ai-agent-system")

  def generate_patch(error_entry, file_path) do
    Logger.info("[PatchEngine] 패치 생성 시작: #{file_path}")

    with {:ok, file_content} <- read_file(file_path),
         {:ok, patch} <- call_hub_llm(error_entry, file_content, file_path) do
      Logger.info("[PatchEngine] 패치 생성 완료")
      {:ok, patch}
    else
      {:error, reason} ->
        Logger.error("[PatchEngine] 패치 생성 실패: #{inspect(reason)}")
        {:error, reason}
    end
  end

  # ── 내부 ───────────────────────────────────────────────────────────

  defp read_file(file_path) do
    full_path = if Path.type(file_path) == :absolute, do: file_path,
                else: Path.join(@project_root, file_path)
    case File.read(full_path) do
      {:ok, content} -> {:ok, String.slice(content, 0, 3000)}  # 토큰 절약
      {:error, reason} -> {:error, {:file_read, reason}}
    end
  end

  defp call_hub_llm(error_entry, file_content, file_path) do
    bot_name = error_entry[:bot_name] || "unknown"
    error_msg = error_entry[:message] || ""
    event_type = error_entry[:event_type] || "error"

    prompt = """
    You are a bug-fixing engineer for a multi-agent automation system.

    Error:
    - Bot: #{bot_name}
    - Type: #{event_type}
    - Message: #{error_msg}

    File: #{file_path}
    Content (truncated):
    ```
    #{file_content}
    ```

    Provide a minimal, safe fix. Respond in this format:
    DIAGNOSIS: (one line)
    FIX: (code change description)
    CONFIDENCE: (0-10)
    """

    # Hub LLM 호출 (로컬 qwen2.5-7b)
    body = Jason.encode!(%{
      model: "qwen2.5:7b",
      prompt: prompt,
      stream: false,
      options: %{temperature: 0.1, num_predict: 500}
    })

    hub_url = "http://127.0.0.1:11434/api/generate"

    case Req.post(hub_url, body: body, headers: [{"content-type", "application/json"}],
                  receive_timeout: 30_000) do
      {:ok, %{status: 200, body: response}} ->
        text = response["response"] || ""
        {:ok, parse_patch_response(text)}
      {:ok, %{status: status}} ->
        {:error, {:llm_status, status}}
      {:error, reason} ->
        {:error, {:llm_call, reason}}
    end
  rescue
    e -> {:error, {:llm_exception, Exception.message(e)}}
  end

  defp parse_patch_response(text) do
    lines = String.split(text, "\n")
    %{
      diagnosis: extract_field(lines, "DIAGNOSIS:"),
      fix: extract_field(lines, "FIX:"),
      confidence: extract_confidence(lines),
      raw: text
    }
  end

  defp extract_field(lines, prefix) do
    lines
    |> Enum.find("", &String.starts_with?(&1, prefix))
    |> String.replace_prefix(prefix, "")
    |> String.trim()
  end

  defp extract_confidence(lines) do
    raw = extract_field(lines, "CONFIDENCE:")
    case Integer.parse(raw) do
      {n, _} -> n
      :error -> 0
    end
  end
end

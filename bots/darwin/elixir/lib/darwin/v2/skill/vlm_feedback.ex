defmodule Darwin.V2.Skill.VLMFeedback do
  @moduledoc """
  VLMFeedback — 구현 출력물의 시각적 평가.

  AI Scientist-v2 VLM feedback 패턴 기반.
  시각적 출력(플롯, 다이어그램, 아키텍처)을 생성하는 논문에 사용.

  모델: claude-opus-4-7 (vision 지원)
  Anthropic API 직접 호출 (멀티모달 메시지).

  입력: image_path 또는 base64_image + expected_description
  출력: 품질 점수, 논문 일치 여부, 피드백, 개선 제안

  시각적 출력이 없으면 %{quality_score: nil, feedback: "No visual output to evaluate"} 반환.
  """

  use Jido.Action,
    name: "darwin_v2_vlm_feedback",
    description: "Visual evaluation of implementation outputs using VLM",
    schema: Zoi.object(%{
      image_path:           Zoi.optional(Zoi.string()),
      base64_image:         Zoi.optional(Zoi.string()),
      image_media_type:     Zoi.default(Zoi.string(), "image/png"),
      expected_description: Zoi.string() |> Zoi.required(),
      paper_title:          Zoi.default(Zoi.string(), "")
    })

  require Logger

  @log_prefix "[다윈V2 스킬:VLM평가]"
  @anthropic_api_url "https://api.anthropic.com/v1/messages"
  @anthropic_version "2023-06-01"
  @vlm_model "claude-opus-4-7"
  @vlm_timeout 60_000

  @impl Jido.Action
  def run(params, _ctx) do
    image_path           = Map.get(params, :image_path)
    base64_image         = Map.get(params, :base64_image)
    image_media_type     = Map.get(params, :image_media_type, "image/png")
    expected_description = Map.fetch!(params, :expected_description)
    paper_title          = Map.get(params, :paper_title, "")

    Logger.info("#{@log_prefix} 시작 — paper=#{paper_title}")

    with :ok <- check_principle(expected_description) do
      cond do
        is_binary(base64_image) and byte_size(base64_image) > 0 ->
          evaluate_image(base64_image, image_media_type, expected_description, paper_title)

        is_binary(image_path) and File.exists?(image_path) ->
          case load_image_as_base64(image_path) do
            {:ok, b64, media_type} ->
              evaluate_image(b64, media_type, expected_description, paper_title)
            {:error, reason} ->
              {:error, {:image_load_failed, reason}}
          end

        true ->
          Logger.info("#{@log_prefix} 시각적 출력 없음 — 빈 결과 반환")
          {:ok, no_visual_result()}
      end
    end
  end

  # --- 이미지 평가 ---

  defp evaluate_image(base64_data, media_type, expected_description, paper_title) do
    prompt_text = """
    You are evaluating the visual output of a research paper implementation.

    Paper: #{if paper_title == "", do: "(not specified)", else: paper_title}
    Expected output description: #{expected_description}

    Carefully evaluate this image on:

    1. quality_score (0-10):
       - 0-3: Poor quality, major artifacts, unreadable
       - 4-6: Acceptable but has notable issues
       - 7-8: Good quality, minor issues
       - 9-10: Excellent, matches paper exactly

    2. matches_paper (true/false):
       Does the visual match what the paper describes/shows?

    3. feedback: Detailed textual feedback (2-4 sentences)

    4. suggestions: List of specific improvements

    5. visual_artifacts: List of identified visual problems
       (e.g., "axis labels missing", "wrong color scheme", "blurry")

    Respond in valid JSON:
    {
      "quality_score": 7.5,
      "matches_paper": true,
      "feedback": "The plot correctly shows the convergence curve...",
      "suggestions": ["Add error bars", "Increase font size"],
      "visual_artifacts": ["legend overlapping with plot area"]
    }
    """

    messages = [
      %{
        "role" => "user",
        "content" => [
          %{
            "type"   => "image",
            "source" => %{
              "type"       => "base64",
              "media_type" => media_type,
              "data"       => base64_data
            }
          },
          %{
            "type" => "text",
            "text" => prompt_text
          }
        ]
      }
    ]

    case call_vlm(messages) do
      {:ok, text} ->
        case parse_json(text) do
          {:ok, parsed} ->
            result = %{
              quality_score:    to_float(Map.get(parsed, "quality_score", 5.0)),
              matches_paper:    Map.get(parsed, "matches_paper", false),
              feedback:         Map.get(parsed, "feedback", ""),
              suggestions:      Map.get(parsed, "suggestions", []),
              visual_artifacts: Map.get(parsed, "visual_artifacts", [])
            }
            Logger.info("#{@log_prefix} 완료 — quality=#{result.quality_score}, matches=#{result.matches_paper}")
            {:ok, result}

          {:error, _} ->
            Logger.warning("#{@log_prefix} JSON 파싱 실패 — 텍스트 응답 사용")
            {:ok, %{
              quality_score:    nil,
              matches_paper:    false,
              feedback:         text,
              suggestions:      [],
              visual_artifacts: ["JSON parse failed — raw feedback above"]
            }}
        end

      {:error, :no_api_key} ->
        Logger.error("#{@log_prefix} API 키 없음")
        {:error, :no_api_key}

      {:error, reason} ->
        Logger.error("#{@log_prefix} VLM 호출 실패 — #{inspect(reason)}")
        {:error, {:vlm_call_failed, reason}}
    end
  end

  # --- VLM API 호출 ---

  defp call_vlm(messages) do
    key = api_key()

    if is_nil(key) or key == "" do
      {:error, :no_api_key}
    else
      body = %{
        "model"      => @vlm_model,
        "max_tokens" => 1024,
        "messages"   => messages
      }

      case Req.post(@anthropic_api_url,
             json: body,
             headers: [
               {"x-api-key", key},
               {"anthropic-version", @anthropic_version}
             ],
             receive_timeout: @vlm_timeout
           ) do
        {:ok, %{status: 200, body: %{"content" => [%{"text" => text} | _]}}} ->
          {:ok, text}

        {:ok, %{status: status, body: body}} ->
          {:error, {:http_error, status, body}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  # --- 이미지 로딩 ---

  defp load_image_as_base64(path) do
    case File.read(path) do
      {:ok, binary} ->
        b64        = Base.encode64(binary)
        media_type = detect_media_type(path)
        {:ok, b64, media_type}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp detect_media_type(path) do
    ext = path |> Path.extname() |> String.downcase()
    case ext do
      ".jpg"  -> "image/jpeg"
      ".jpeg" -> "image/jpeg"
      ".png"  -> "image/png"
      ".gif"  -> "image/gif"
      ".webp" -> "image/webp"
      ".pdf"  -> "application/pdf"
      _       -> "image/png"
    end
  end

  # --- 헬퍼 ---

  defp no_visual_result do
    %{
      quality_score:    nil,
      matches_paper:    false,
      feedback:         "No visual output to evaluate",
      suggestions:      [],
      visual_artifacts: []
    }
  end

  defp check_principle(expected_description) do
    case Darwin.V2.Principle.Loader.check(:vlm_feedback, %{expected_description: expected_description}) do
      :ok              -> :ok
      {:ok, _}         -> :ok
      {:error, reason} -> {:error, {:principle_violation, reason}}
    end
  rescue
    _ -> :ok
  end

  defp api_key do
    System.get_env("ANTHROPIC_API_KEY") ||
      System.get_env("DARWIN_ANTHROPIC_API_KEY")
  end

  defp to_float(v) when is_float(v),   do: v
  defp to_float(v) when is_integer(v), do: v * 1.0
  defp to_float(v) when is_binary(v) do
    case Float.parse(v) do
      {f, _} -> f
      :error -> 5.0
    end
  end
  defp to_float(_), do: 5.0

  defp parse_json(text) when is_binary(text) do
    cleaned =
      text
      |> String.replace(~r/```json\s*/i, "")
      |> String.replace(~r/```\s*/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, parsed} -> {:ok, parsed}
      {:error, _}   ->
        case Regex.run(~r/\{[\s\S]*\}/m, cleaned) do
          [json_str | _] -> Jason.decode(json_str)
          nil            -> {:error, :no_json_found}
        end
    end
  end
  defp parse_json(_), do: {:error, :not_a_string}
end

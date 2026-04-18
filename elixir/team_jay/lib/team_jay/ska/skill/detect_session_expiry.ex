defmodule TeamJay.Ska.Skill.DetectSessionExpiry do
  @moduledoc """
  세션 만료 감지 스킬 — Andy/Jimmy/Pickko 모두 사용.

  입력: %{agent: :andy, response_html: "...", status_code: 200}
  출력: {:ok, %{status: :healthy | :expired | :suspicious, reason: string}}
  """

  @behaviour TeamJay.Ska.Skill

  @impl true
  def metadata do
    %{
      name: :detect_session_expiry,
      domain: :common,
      version: "1.0",
      description: "에이전트 세션 만료 여부 감지",
      input_schema: %{agent: :atom, response_html: :string, status_code: :integer},
      output_schema: %{status: :atom, reason: :string}
    }
  end

  @impl true
  def run(params, _context) do
    html = params[:response_html] || ""
    status_code = params[:status_code]

    result =
      cond do
        String.contains?(html, "nid.naver.com/nidlogin") ->
          %{status: :expired, reason: "redirected_to_login"}

        status_code in [401, 403] ->
          %{status: :expired, reason: "auth_status_code_#{status_code}"}

        String.contains?(html, "로그인이 필요") ->
          %{status: :expired, reason: "login_required_message"}

        byte_size(html) < 500 and status_code == 200 ->
          %{status: :suspicious, reason: "suspicious_short_response"}

        true ->
          %{status: :healthy, reason: "normal"}
      end

    {:ok, result}
  end

  @impl true
  def health_check, do: :ok
end

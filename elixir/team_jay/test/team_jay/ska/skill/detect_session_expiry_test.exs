defmodule TeamJay.Ska.Skill.DetectSessionExpiryTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.DetectSessionExpiry

  describe "run/2" do
    test "네이버 로그인 리다이렉트 → :expired" do
      html = "<html>...nid.naver.com/nidlogin...</html>"
      assert {:ok, %{status: :expired, reason: "redirected_to_login"}} =
               DetectSessionExpiry.run(%{agent: :andy, response_html: html, status_code: 200}, %{})
    end

    test "401 상태 코드 → :expired" do
      assert {:ok, %{status: :expired, reason: "auth_status_code_401"}} =
               DetectSessionExpiry.run(%{agent: :andy, response_html: "<html></html>", status_code: 401}, %{})
    end

    test "403 상태 코드 → :expired" do
      assert {:ok, %{status: :expired, reason: "auth_status_code_403"}} =
               DetectSessionExpiry.run(%{agent: :andy, response_html: "<html></html>", status_code: 403}, %{})
    end

    test "'로그인이 필요' 문구 → :expired" do
      html = "<html>로그인이 필요합니다</html>"
      assert {:ok, %{status: :expired, reason: "login_required_message"}} =
               DetectSessionExpiry.run(%{agent: :andy, response_html: html, status_code: 200}, %{})
    end

    test "500바이트 미만 200 응답 → :suspicious" do
      short_html = String.duplicate("x", 100)
      assert {:ok, %{status: :suspicious, reason: "suspicious_short_response"}} =
               DetectSessionExpiry.run(%{agent: :andy, response_html: short_html, status_code: 200}, %{})
    end

    test "정상 응답 → :healthy" do
      html = String.duplicate("normal content", 50)
      assert {:ok, %{status: :healthy, reason: "normal"}} =
               DetectSessionExpiry.run(%{agent: :andy, response_html: html, status_code: 200}, %{})
    end

    test "html nil 처리" do
      assert {:ok, %{status: :healthy}} =
               DetectSessionExpiry.run(%{agent: :andy, status_code: 200}, %{})
    end
  end

  describe "metadata/0" do
    test "메타데이터 반환" do
      meta = DetectSessionExpiry.metadata()
      assert meta.name == :detect_session_expiry
      assert meta.domain == :common
      assert meta.version == "1.0"
    end
  end

  describe "health_check/0" do
    test ":ok 반환" do
      assert :ok = DetectSessionExpiry.health_check()
    end
  end
end

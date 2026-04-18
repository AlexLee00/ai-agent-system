defmodule TeamJay.Ska.Skill.GenerateReportTest do
  use ExUnit.Case, async: true
  alias TeamJay.Ska.Skill.GenerateReport

  describe "metadata/0" do
    test "스킬 메타데이터 반환" do
      meta = GenerateReport.metadata()
      assert meta.name == :generate_report
      assert meta.domain == :analytics
    end
  end

  describe "health_check/0" do
    test "항상 ok" do
      assert :ok = GenerateReport.health_check()
    end
  end

  describe "run/2" do
    test "기본 리포트 생성 (Telegram 발송 없이)" do
      System.put_env("SKA_PYTHON_SKILL_ENABLED", "false")

      assert {:ok, result} =
               GenerateReport.run(
                 %{period: :daily, sections: [:reservations, :anomalies], send_telegram: false},
                 %{}
               )

      assert is_binary(result.markdown)
      assert String.contains?(result.markdown, "일일 리포트")
      assert result.section_count == 2
      assert result.telegram_sent == false
    end

    test "Markdown에 날짜 포함" do
      assert {:ok, result} =
               GenerateReport.run(
                 %{period: :weekly, sections: [:reservations], send_telegram: false},
                 %{}
               )

      today = Date.utc_today() |> Date.to_string()
      assert String.contains?(result.markdown, today)
      assert String.contains?(result.markdown, "주간 리포트")
    end

    test "알 수 없는 섹션도 처리" do
      assert {:ok, result} =
               GenerateReport.run(
                 %{period: :daily, sections: [:unknown_section], send_telegram: false},
                 %{}
               )

      assert result.section_count == 1
    end
  end
end

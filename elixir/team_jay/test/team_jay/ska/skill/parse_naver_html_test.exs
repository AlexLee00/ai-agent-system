defmodule TeamJay.Ska.Skill.ParseNaverHtmlTest do
  use ExUnit.Case, async: true

  alias TeamJay.Ska.Skill.ParseNaverHtml

  describe "metadata/0" do
    test "도메인 :naver" do
      meta = ParseNaverHtml.metadata()
      assert meta.name == :parse_naver_html
      assert meta.domain == :naver
      assert meta.version == "1.0"
    end
  end
end

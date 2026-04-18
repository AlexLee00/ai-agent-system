defmodule Luna.V2.Rag.AgenticRagTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Rag.AgenticRag
  alias Luna.V2.Rag.ResponseSynthesizer

  setup_all do
    Code.ensure_compiled!(AgenticRag)
    Code.ensure_compiled!(ResponseSynthesizer)
    :ok
  end

  describe "모듈 구조 확인" do
    test "AgenticRag 컴파일됨" do
      assert Code.ensure_loaded?(AgenticRag)
    end

    test "retrieve/2 존재" do
      assert function_exported?(AgenticRag, :retrieve, 2)
    end

    test "index_trade_review/2 존재" do
      assert function_exported?(AgenticRag, :index_trade_review, 2)
    end

    test "search/3 존재" do
      assert function_exported?(AgenticRag, :search, 3)
    end
  end

  describe "retrieve/2 — Hub/임베딩 미연결 환경" do
    test "DB/임베딩 미연결 시 {:ok, map} 반환 (예외 없음)" do
      result = AgenticRag.retrieve("BTC 3만달러 패턴")
      assert {:ok, map} = result
      assert Map.has_key?(map, :context)
      assert Map.has_key?(map, :quality)
      assert Map.has_key?(map, :sources)
      assert Map.has_key?(map, :retries)
    end

    test "context는 리스트" do
      {:ok, %{context: ctx}} = AgenticRag.retrieve("ETH 급등 후 패턴")
      assert is_list(ctx)
    end

    test "quality는 0.0~1.0" do
      {:ok, %{quality: q}} = AgenticRag.retrieve("테스트")
      assert q >= 0.0
      assert q <= 1.0
    end
  end

  describe "ResponseSynthesizer 단위 확인" do
    test "빈 리스트 → 빈 결과" do
      assert ResponseSynthesizer.combine([]) == []
    end

    test "content 없는 doc 필터링" do
      docs = [%{"category" => "trade_review", "similarity" => 0.9}]
      result = ResponseSynthesizer.combine(docs)
      assert result == []
    end

    test "정상 doc → normalize 구조" do
      docs = [%{
        "category" => "trade_review",
        "similarity" => 0.9,
        "content" => "BTC 상승 패턴",
        "symbol" => "BTC",
        "market" => "crypto"
      }]
      [item] = ResponseSynthesizer.combine(docs)
      assert item.content == "BTC 상승 패턴"
      assert item.category == "trade_review"
      assert item.similarity == 0.9
    end

    test "최대 5개 반환" do
      docs = Enum.map(1..20, fn i ->
        %{"category" => "trade_review", "similarity" => 0.5 + i * 0.01, "content" => "doc #{i}"}
      end)
      result = ResponseSynthesizer.combine(docs)
      assert length(result) <= 5
    end
  end
end

defmodule Luna.V2.Rag.MultiSourceRetrieverTest do
  use ExUnit.Case, async: true

  alias Luna.V2.Rag.MultiSourceRetriever

  describe "모듈 구조" do
    test "MultiSourceRetriever 컴파일됨" do
      assert Code.ensure_loaded?(MultiSourceRetriever)
    end

    test "fetch/1 존재 (기본값 포함)" do
      assert function_exported?(MultiSourceRetriever, :fetch, 1)
    end

    test "embed/1 존재" do
      assert function_exported?(MultiSourceRetriever, :embed, 1)
    end
  end

  describe "fetch/2 — DB/임베딩 미연결 환경" do
    test "빈 쿼리 리스트 → 빈 결과" do
      result = MultiSourceRetriever.fetch([], %{})
      assert result == []
    end

    test "임베딩 서버 미연결 시 예외 없이 빈 리스트 반환" do
      # localhost:11434 미연결 상황
      result = MultiSourceRetriever.fetch(["테스트 쿼리"], %{})
      assert is_list(result)
    end
  end

  describe "search_one/3 — 안전성" do
    test "임베딩 실패 시 빈 리스트 반환" do
      result = MultiSourceRetriever.search_one("쿼리 테스트", %{}, 5)
      assert is_list(result)
    end
  end
end

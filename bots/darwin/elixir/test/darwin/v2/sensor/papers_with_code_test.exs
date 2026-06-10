defmodule Darwin.V2.Sensor.PapersWithCodeTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.Sensor.PapersWithCode

  describe "normalize_response_body/1" do
    test "keeps already decoded map bodies" do
      body = %{"count" => 1, "results" => []}

      assert PapersWithCode.normalize_response_body(body) == {:ok, body}
    end

    test "decodes binary JSON bodies from the API" do
      body = Jason.encode!(%{"count" => 1, "results" => [%{"id" => "paper-1"}]})

      assert {:ok, %{"count" => 1, "results" => [%{"id" => "paper-1"}]}} =
               PapersWithCode.normalize_response_body(body)
    end

    test "converts HuggingFace trending HTML fallback into paper results" do
      body = """
      <!doctype html>
      <html>
        <body>
          <article>
            <h3 class="mb-1.5 text-xl">
              <a href="/papers/2412.20138" class="line-clamp-2 cursor-pointer text-balance">TradingAgents: Multi-Agents LLM Financial Trading Framework</a>
            </h3>
            <div><p class="line-clamp-2 text-sm">A multi-agent framework using LLMs for stock trading &amp; evaluation.</p></div>
          </article>
        </body>
      </html>
      """

      assert {:ok, %{"count" => 1, "results" => [paper]}} =
               PapersWithCode.normalize_response_body(body)

      assert paper["id"] == "2412.20138"
      assert paper["arxiv_id"] == "2412.20138"
      assert paper["source"] == "huggingface_papers_trending"
      assert paper["url"] == "https://huggingface.co/papers/2412.20138"
      assert paper["abstract"] == "A multi-agent framework using LLMs for stock trading & evaluation."
    end

    test "rejects invalid or non-map bodies" do
      assert PapersWithCode.normalize_response_body("not json") == {:error, :unexpected_body}
      assert PapersWithCode.normalize_response_body("[1,2,3]") == {:error, :unexpected_body}
      assert PapersWithCode.normalize_response_body([]) == {:error, :unexpected_body}
    end
  end
end

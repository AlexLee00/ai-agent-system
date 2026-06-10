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

    test "rejects invalid or non-map bodies" do
      assert PapersWithCode.normalize_response_body("not json") == {:error, :unexpected_body}
      assert PapersWithCode.normalize_response_body("[1,2,3]") == {:error, :unexpected_body}
      assert PapersWithCode.normalize_response_body([]) == {:error, :unexpected_body}
    end
  end
end

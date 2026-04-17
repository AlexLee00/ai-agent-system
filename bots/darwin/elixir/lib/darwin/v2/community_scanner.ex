defmodule Darwin.V2.CommunityScanner do
  @moduledoc """
  커뮤니티 시그널 스캐너 — HN/Reddit/GitHub Trending에서 화제 논문/기술 탐지.
  D(community signal) 소스: 커뮤니티 반응이 높은 논문 = 실용성 높음.
  반환: [{title, score, source, url}]
  """

  require Logger

  @hn_api_url "https://hacker-news.firebaseio.com/v0"
  @reddit_api_url "https://www.reddit.com/r/MachineLearning/new.json"
  @max_items 20

  @doc "모든 커뮤니티 소스에서 시그널 수집."
  @spec fetch_signals() :: [map()]
  def fetch_signals do
    hn_signals = fetch_hn_signals()
    reddit_signals = fetch_reddit_signals()
    (hn_signals ++ reddit_signals) |> Enum.sort_by(& -(&1[:score] || 0)) |> Enum.take(@max_items)
  rescue
    e ->
      Logger.warning("[darwin/community] 시그널 수집 실패: #{inspect(e)}")
      []
  end

  @doc "HN(Hacker News) Ask/Show AI 논문 시그널."
  @spec fetch_hn_signals() :: [map()]
  def fetch_hn_signals do
    # HN 상위 스토리 조회
    case Req.get("#{@hn_api_url}/topstories.json", receive_timeout: 10_000) do
      {:ok, %{status: 200, body: ids}} when is_list(ids) ->
        ids
        |> Enum.take(100)
        |> Enum.filter(fn id -> is_integer(id) end)
        |> Enum.map(&fetch_hn_item/1)
        |> Enum.filter(&ai_related?/1)
        |> Enum.map(fn item ->
          %{
            title: item["title"] || "",
            score: item["score"] || 0,
            source: "hn",
            url: item["url"] || "https://news.ycombinator.com/item?id=#{item["id"]}"
          }
        end)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  @doc "Reddit r/MachineLearning 최신 논문 시그널."
  @spec fetch_reddit_signals() :: [map()]
  def fetch_reddit_signals do
    case Req.get(@reddit_api_url,
      headers: [{"user-agent", "darwin-research-bot/1.0"}],
      receive_timeout: 10_000
    ) do
      {:ok, %{status: 200, body: %{"data" => %{"children" => posts}}}} when is_list(posts) ->
        posts
        |> Enum.map(fn %{"data" => post} ->
          %{
            title: post["title"] || "",
            score: post["score"] || 0,
            source: "reddit",
            url: post["url"] || ""
          }
        end)
        |> Enum.filter(&ai_related?/1)

      _ ->
        []
    end
  rescue
    _ -> []
  end

  defp fetch_hn_item(id) do
    case Req.get("#{@hn_api_url}/item/#{id}.json", receive_timeout: 5_000) do
      {:ok, %{status: 200, body: item}} when is_map(item) -> item
      _ -> %{}
    end
  rescue
    _ -> %{}
  end

  defp ai_related?(item) when is_map(item) do
    title = String.downcase(item[:title] || item["title"] || "")
    keywords = ["llm", "transformer", "neural", "arxiv", "paper", "ai", "ml", "agent", "gpt", "claude", "qwen", "deepseek"]
    Enum.any?(keywords, &String.contains?(title, &1))
  end
  defp ai_related?(_), do: false
end

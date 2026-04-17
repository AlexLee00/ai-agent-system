defmodule Darwin.V2.MCP.Client do
  @moduledoc """
  Darwin V2 MCP 클라이언트 — 외부 MCP 서버(Python) HTTP 호출.

  지원 서버:
    - arxiv-mcp-server: DARWIN_MCP_ARXIV_URL (기본 http://localhost:8765)
    - paper-search-mcp: DARWIN_MCP_PAPERS_URL (기본 http://localhost:8766)

  지원 오퍼레이션:
    - search_papers/2  - (query, opts) → [%{title, url, abstract, source}]
    - get_paper/1      - (arxiv_id) → full paper metadata
    - get_citation_graph/1 - (arxiv_id) → [{cited_id, title}]

  MCP 서버 미연결 시: {:error, :mcp_unavailable}
  """

  require Logger

  @log_prefix "[다윈V2 MCP클라이언트]"
  @default_arxiv_url "http://localhost:8765"
  @default_papers_url "http://localhost:8766"
  @request_timeout_ms 30_000

  # Public API

  @doc """
  논문 검색. query는 키워드 문자열, opts는 선택적 키워드.
  opts:
    - limit: integer (기본 10)
    - source: "arxiv" | "semantic_scholar" | "all" (기본 "all")

  반환: {:ok, [%{title, url, abstract, source}]} | {:error, term}
  """
  @spec search_papers(String.t(), keyword()) :: {:ok, list(map())} | {:error, term()}
  def search_papers(query, opts \\ []) do
    limit  = Keyword.get(opts, :limit, 10)
    source = Keyword.get(opts, :source, "all")

    payload = %{
      jsonrpc: "2.0",
      id: gen_id(),
      method: "tools/call",
      params: %{
        name: "search_papers",
        arguments: %{query: query, limit: limit, source: source}
      }
    }

    server_url = if source == "arxiv", do: arxiv_url(), else: papers_url()

    case call_mcp(server_url, payload) do
      {:ok, results} when is_list(results) ->
        normalized = Enum.map(results, &normalize_paper/1)
        {:ok, normalized}

      {:ok, result} when is_map(result) ->
        {:ok, [normalize_paper(result)]}

      {:error, _} = err -> err
    end
  end

  @doc """
  단일 논문 전체 메타데이터 조회.
  반환: {:ok, %{title, url, abstract, authors, published_at, ...}} | {:error, term}
  """
  @spec get_paper(String.t()) :: {:ok, map()} | {:error, term()}
  def get_paper(arxiv_id) when is_binary(arxiv_id) do
    payload = %{
      jsonrpc: "2.0",
      id: gen_id(),
      method: "tools/call",
      params: %{
        name: "get_paper",
        arguments: %{arxiv_id: arxiv_id}
      }
    }

    case call_mcp(arxiv_url(), payload) do
      {:ok, result} when is_map(result) ->
        {:ok, normalize_paper(result)}

      {:ok, [result | _]} ->
        {:ok, normalize_paper(result)}

      {:error, _} = err -> err
    end
  end

  @doc """
  인용 그래프 조회. 해당 arxiv 논문이 인용하는 논문 목록.
  반환: {:ok, [{cited_id, title}]} | {:error, term}
  """
  @spec get_citation_graph(String.t()) :: {:ok, list({String.t(), String.t()})} | {:error, term()}
  def get_citation_graph(arxiv_id) when is_binary(arxiv_id) do
    payload = %{
      jsonrpc: "2.0",
      id: gen_id(),
      method: "tools/call",
      params: %{
        name: "get_citation_graph",
        arguments: %{arxiv_id: arxiv_id}
      }
    }

    case call_mcp(papers_url(), payload) do
      {:ok, edges} when is_list(edges) ->
        result = Enum.map(edges, fn edge ->
          cited_id = Map.get(edge, "cited_id") || Map.get(edge, "id", "")
          title    = Map.get(edge, "title", "")
          {cited_id, title}
        end)
        {:ok, result}

      {:error, _} = err -> err
    end
  end

  # Private

  defp call_mcp(url, payload) do
    case Req.post(url,
      json: payload,
      receive_timeout: @request_timeout_ms,
      headers: [
        {"Content-Type", "application/json"},
        {"Accept", "application/json"}
      ]
    ) do
      {:ok, %{status: 200, body: body}} ->
        parse_jsonrpc_response(body)

      {:ok, %{status: status, body: body}} ->
        Logger.warning("#{@log_prefix} MCP 응답 오류 — HTTP #{status}: #{inspect(body)}")
        {:error, {:http_error, status}}

      {:error, %{reason: :econnrefused}} ->
        Logger.debug("#{@log_prefix} MCP 서버 연결 불가 (#{url}) — mcp_unavailable")
        {:error, :mcp_unavailable}

      {:error, reason} ->
        Logger.error("#{@log_prefix} MCP 요청 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.error("#{@log_prefix} MCP 호출 예외: #{inspect(e)}")
      {:error, :mcp_unavailable}
  end

  defp parse_jsonrpc_response(%{"result" => result}) do
    # MCP 표준: result.content[].text JSON 혹은 직접 result
    case result do
      %{"content" => [%{"type" => "text", "text" => text} | _]} ->
        case Jason.decode(text) do
          {:ok, decoded} -> {:ok, decoded}
          _ -> {:ok, text}
        end

      list when is_list(list) ->
        {:ok, list}

      map when is_map(map) ->
        {:ok, map}

      other ->
        {:ok, other}
    end
  end

  defp parse_jsonrpc_response(%{"error" => error}) do
    message = Map.get(error, "message", "unknown MCP error")
    code    = Map.get(error, "code", -1)
    Logger.warning("#{@log_prefix} JSON-RPC 오류 #{code}: #{message}")
    {:error, {:jsonrpc_error, code, message}}
  end

  defp parse_jsonrpc_response(body) when is_map(body) do
    {:ok, body}
  end

  defp parse_jsonrpc_response(other) do
    {:ok, other}
  end

  defp normalize_paper(raw) when is_map(raw) do
    %{
      title:        Map.get(raw, "title", "") |> to_string() |> String.trim(),
      url:          Map.get(raw, "url", Map.get(raw, "link", Map.get(raw, "pdf_url", ""))) |> to_string(),
      abstract:     Map.get(raw, "abstract", Map.get(raw, "summary", "")) |> to_string(),
      source:       Map.get(raw, "source", "mcp") |> to_string(),
      authors:      Map.get(raw, "authors", []),
      published_at: parse_date_field(Map.get(raw, "published_at", Map.get(raw, "published", nil))),
      metadata:     Map.drop(raw, ["title", "url", "link", "abstract", "summary", "source", "authors", "published_at", "published"])
    }
  end

  defp normalize_paper(other), do: %{title: "", url: "", abstract: inspect(other), source: "mcp", published_at: DateTime.utc_now(), metadata: %{}}

  defp parse_date_field(nil), do: DateTime.utc_now()
  defp parse_date_field(str) when is_binary(str) do
    case DateTime.from_iso8601(str) do
      {:ok, dt, _} -> dt
      _ -> DateTime.utc_now()
    end
  end
  defp parse_date_field(%DateTime{} = dt), do: dt
  defp parse_date_field(_), do: DateTime.utc_now()

  defp arxiv_url do
    System.get_env("DARWIN_MCP_ARXIV_URL", @default_arxiv_url)
  end

  defp papers_url do
    System.get_env("DARWIN_MCP_PAPERS_URL", @default_papers_url)
  end

  defp gen_id do
    :erlang.unique_integer([:positive, :monotonic])
  end
end

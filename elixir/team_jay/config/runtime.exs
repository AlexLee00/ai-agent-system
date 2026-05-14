import Config

langfuse_host =
  System.get_env("LANGFUSE_HOST", "http://localhost:3000")
  |> String.trim_trailing("/")

langfuse_project_id = System.get_env("LANGFUSE_PROJECT_ID", "team-jay-prod")
langfuse_enabled? = System.get_env("LANGFUSE_OTEL_ENABLED") in ["1", "true", "TRUE", "yes"]
langfuse_public_key = System.get_env("LANGFUSE_PUBLIC_KEY", "")
langfuse_secret_key = System.get_env("LANGFUSE_SECRET_KEY", "")

config :team_jay, :langfuse,
  enabled: langfuse_enabled?,
  host: langfuse_host,
  project_id: langfuse_project_id

if langfuse_enabled? and langfuse_public_key != "" and langfuse_secret_key != "" do
  credentials = Base.encode64("#{langfuse_public_key}:#{langfuse_secret_key}")

  config :opentelemetry,
    span_processor: :batch,
    traces_exporter: :otlp

  config :opentelemetry_exporter,
    otlp_protocol: :http_protobuf,
    otlp_endpoint: System.get_env("LANGFUSE_OTEL_ENDPOINT", "#{langfuse_host}/api/public/otel"),
    otlp_headers: [{"authorization", "Basic #{credentials}"}]
end

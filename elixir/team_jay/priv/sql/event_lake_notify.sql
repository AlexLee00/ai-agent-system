CREATE OR REPLACE FUNCTION agent.notify_event_lake()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('event_lake_insert', json_build_object(
    'id', NEW.id,
    'event_type', NEW.event_type,
    'team', NEW.team,
    'bot_name', NEW.bot_name,
    'title', NEW.title
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_lake_notify ON agent.event_lake;
CREATE TRIGGER event_lake_notify
  AFTER INSERT ON agent.event_lake
  FOR EACH ROW
  EXECUTE FUNCTION agent.notify_event_lake();


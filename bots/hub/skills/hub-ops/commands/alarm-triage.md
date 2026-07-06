# Alarm Triage

1. Identify `team`, `alarm_type`, `incident_key`, `cluster_key`, and current `fingerprint`.
2. If duplicate rows differ only by title text, prefer lifecycle normalized labels.
3. Check `fingerprint_count`, `status`, `received_at`, and `resolved_at`.
4. Use lifecycle simulation before enabling `HUB_ALARM_LIFECYCLE_ENABLED`.
5. Keep Telegram delivery out of dry-run checks.

Default repeat interval is 6 hours. TTL auto-resolve is a mirror-state transition, not a delivery event.

/**
 * Compatibility shim.
 *
 * New code should import ./hub-alarm-client. This file stays in place so older
 * bots do not break while we remove OpenClaw naming from the active Hub path.
 */
export {
  postAlarm,
  readRecentAlertSnapshot,
  _testOnly_isHubAlarmDeliveryAccepted,
  _testOnly_isLegacyOpenClawFallbackEnabled,
  _testOnly_isLegacyWebhookFallbackEnabled,
} from './hub-alarm-client';

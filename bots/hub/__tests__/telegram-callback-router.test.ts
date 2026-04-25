'use strict';

describe('telegram callback router', () => {
  test('routes hub_control and darwin compatibility callbacks', () => {
    const { resolveHubCallbackTarget } = require('../lib/telegram/callback-router.ts');
    expect(resolveHubCallbackTarget('hub_control:approve:run_1')).toEqual({
      route: '/hub/control/callback',
      mode: 'hub_control',
    });
    expect(resolveHubCallbackTarget('darwin_approve:123')).toEqual({
      route: '/hub/darwin/callback',
      mode: 'darwin_compat',
    });
    expect(resolveHubCallbackTarget('unknown_action')).toBeNull();
  });
});

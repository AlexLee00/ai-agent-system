'use strict';

describe('Gemini CLI cancellation', () => {
  afterEach(() => {
    delete process.env.HUB_LLM_GEMINI_DISABLED;
    delete process.env.GEMINI_CLI_COMMAND;
    jest.resetModules();
    jest.restoreAllMocks();
  });

  test('passes the shared attempt signal to the CLI process', async () => {
    const execFile = jest.fn((_command, _args, options, callback) => {
      setImmediate(() => callback(Object.assign(new Error('aborted'), { name: 'AbortError' }), '', ''));
      return { kill: jest.fn() };
    });
    jest.doMock('child_process', () => ({ execFile }));
    process.env.HUB_LLM_GEMINI_DISABLED = 'false';
    process.env.GEMINI_CLI_COMMAND = 'gemini';

    const controller = new AbortController();
    const { callGeminiCliOAuth } = require('../lib/llm/oauth-direct.ts');
    const result = await callGeminiCliOAuth({
      prompt: 'test',
      model: 'gemini-2.5-flash',
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][2].signal).toBe(controller.signal);
  });
});

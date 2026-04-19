/**
 * Darwin signal receiver TS bridge.
 *
 * 실제 advisory 소비는 Elixir `Darwin.V2.SignalReceiver`가 담당한다.
 * 이 파일은 TS runtime path audit와 문서화용 bridge만 제공한다.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

export function describeSignalReceiverRuntime() {
  return {
    owner: 'Darwin.V2.SignalReceiver',
    implementation: 'elixir_pubsub',
    subscribed_topics: [
      'sigma.advisory.darwin.knowledge_capture',
      'sigma.advisory.darwin.research_topic',
      'sigma.advisory.darwin.priority_boost',
    ],
    implementation_path: path.resolve(
      path.dirname(__filename),
      '../elixir/lib/darwin/v2/signal_receiver.ex',
    ),
  };
}

function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === __filename);
}

if (isDirectExecution()) {
  const runtime = describeSignalReceiverRuntime();
  console.log('[darwin-signal] TS bridge only; runtime handled by Elixir SignalReceiver');
  console.log(JSON.stringify(runtime, null, 2));
}

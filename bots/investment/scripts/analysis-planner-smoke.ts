// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  summarizeAnalysisPlannerScenarios,
  renderAnalysisPlannerScenarioSummary,
} from '../shared/analysis-planner-scenarios.ts';

export async function runAnalysisPlannerSmoke({ json = false } = {}) {
  const summary = summarizeAnalysisPlannerScenarios();
  if (json) return summary;
  return {
    ...summary,
    text: renderAnalysisPlannerScenarioSummary(),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = process.argv.slice(2);
      const json = args.includes('--json');
      return runAnalysisPlannerSmoke({ json });
    },
    onSuccess: async (result) => {
      if (result?.text) {
        console.log(result.text);
        return;
      }
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[analysis-planner-smoke]',
  });
}

export default {
  runAnalysisPlannerSmoke,
};

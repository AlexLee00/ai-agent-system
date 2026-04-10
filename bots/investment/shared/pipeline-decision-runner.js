const loaded = await import('./pipeline-decision-runner.legacy.js');

export const runDecisionExecutionPipeline = loaded.runDecisionExecutionPipeline;
export default loaded.default ?? loaded;

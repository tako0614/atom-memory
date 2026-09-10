import { llamaCppModel } from './llama-cpp.mjs';
import { writerScenario } from './writer.mjs';
import { writeFileSync } from 'node:fs';
if (!process.env.LLAMA_URL) {
  console.log(
    '実LLMは未実行: LLAMA_URLを明示してください。例: LLAMA_URL=http://127.0.0.1:8080 npm run example:live',
  );
} else {
  const model = llamaCppModel({
    url: process.env.LLAMA_URL,
    // Host workflow: the model supplies content, roles and refs; a validated
    // relationship result advances the sample to its finish step.
    actionKinds: (input) =>
      input.observations.some((item) => item.operation === 'write' && item.links?.length >= 2)
        ? ['finish']
        : ['write'],
    id: process.env.LLAMA_MODEL_ID ?? 'llama-cpp-chat-v2',
    contextWindow: Number(process.env.LLAMA_CONTEXT ?? 8192),
  });
  const actions = [];
  const serialize = model.serialize.bind(model);
  // The host presents the current workflow step explicitly. This is not a claim
  // that a model can plan or terminate arbitrary editing tasks on its own.
  model.serialize = (input) => {
    const written = input.observations.filter((item) => item.operation === 'write');
    const source = input.memory.memory?.find((item) => item.provenance?.origin === 'source');
    const step = written.some((item) => item.links?.length >= 2)
      ? 'The description and relationship are already staged. Finish now. Do not write again.'
      : written.length
        ? `Write a relationship Atom NOW. Its content.links must connect BOTH the description ref ${written[0].ref} AND the original source ref ${source?.ref}. Use two distinct role names and include both refs. Do not write another description or a single-target link.`
        : 'Write a description Atom NOW. Set content to the string 旧クライアント認証の整理. Relationships will be created in the following step.';
    return serialize({
      ...input,
      instruction: `${input.instruction}\nCURRENT HOST WORKFLOW STEP: ${step}`,
    });
  };
  const respond = model.respond.bind(model);
  model.respond = async (...args) => {
    const result = await respond(...args);
    actions.push(result);
    return result;
  };
  const report = {
    model: model.id,
    syntheticData: true,
    workflow:
      'Host presents description/relationship/finish stages from validated observations; model generates content, roles and refs. This is not an unconstrained planner benchmark.',
    generatedAt: new Date().toISOString(),
    actions,
  };
  try {
    const result = await writerScenario(model);
    Object.assign(report, {
      status: 'passed',
      writer: result.writerRun,
      firstTokens: result.first.tokenCount,
      rereadTokens: result.reread.tokenCount,
      historicalItems: result.history.items.length,
    });
  } catch (error) {
    Object.assign(report, { status: 'failed', error: error.message });
    process.exitCode = 1;
  }
  const serialized = JSON.stringify(report, null, 2) + '\n';
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex !== -1) {
    if (!process.argv[reportIndex + 1]) throw Error('--report requires a path');
    writeFileSync(process.argv[reportIndex + 1], serialized);
  }
  console.log(serialized);
}

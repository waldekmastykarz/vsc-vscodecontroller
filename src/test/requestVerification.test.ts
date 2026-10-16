import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findHarnessMismatch, findModelMismatch } from '../requestVerification';

const sessionTypes = ['agent-host-copilotcli', 'copilot-cloud-agent', 'copilotcli', 'local'];

describe('findHarnessMismatch', () => {
  it('accepts a local request handled by the default agent', () => {
    assert.equal(findHarnessMismatch('local', 'github.copilot.editsAgent', sessionTypes), undefined);
  });

  it('rejects a local request that policy moved to the Copilot harness', () => {
    // Captured from VS Code 1.142 with a managed `permissions.*` setting.
    assert.match(findHarnessMismatch('local', 'agent-host-copilotcli', sessionTypes)!, /ran in harness 'agent-host-copilotcli' instead of .* 'local'/);
  });

  it('rejects a local request handled by another session type agent', () => {
    assert.match(findHarnessMismatch('local', 'copilotcli', sessionTypes)!, /harness 'copilotcli'/);
  });

  it('accepts a request handled by the agent of the requested session type', () => {
    assert.equal(findHarnessMismatch('agent-host-copilotcli', 'agent-host-copilotcli', sessionTypes), undefined);
    assert.equal(findHarnessMismatch('copilotcli', 'copilotcli', sessionTypes), undefined);
  });

  it('rejects a request handled by another agent', () => {
    assert.match(findHarnessMismatch('agent-host-copilotcli', 'github.copilot.editsAgent', sessionTypes)!, /agent 'github.copilot.editsAgent'/);
  });

  it('rejects a request without a recorded agent', () => {
    assert.match(findHarnessMismatch('local', undefined, sessionTypes)!, /didn't record which agent/);
  });
});

const agentHostModel = { vendor: 'agent-host-copilotcli', id: 'model-a', name: 'Model A' };
const localModel = { vendor: 'copilot', id: 'model-b', name: 'Model B' };

describe('findModelMismatch', () => {
  it('accepts a request served by the expected agent host model', () => {
    const served = { modelId: 'agent-host-copilotcli:model-a', agentId: 'agent-host-copilotcli', details: 'Model A • 1x' };
    assert.equal(findModelMismatch(agentHostModel, served), undefined);
  });

  it('accepts a request served by the expected local model', () => {
    const served = { modelId: 'copilot/model-b', agentId: 'github.copilot.editsAgent', details: 'Model B • 1x' };
    assert.equal(findModelMismatch(localModel, served), undefined);
  });

  it('rejects a request sent with another model', () => {
    const served = { modelId: 'agent-host-copilotcli:model-c', agentId: 'agent-host-copilotcli', details: 'Model C • 1x' };
    assert.match(findModelMismatch(agentHostModel, served)!, /sent the request with model 'agent-host-copilotcli:model-c'/);
  });

  it('rejects a model the agent host ignores', () => {
    // Captured from VS Code 1.142: the agent host silently used its default model.
    const served = { modelId: 'copilot/model-b', agentId: 'agent-host-copilotcli', details: 'Default Model • 1x' };
    assert.match(findModelMismatch(localModel, served)!, /Agent 'agent-host-copilotcli' .* vendor 'copilot'/);
  });

  it('rejects an agent host model sent to another agent', () => {
    const served = { modelId: 'agent-host-copilotcli:model-a', agentId: 'github.copilot.editsAgent' };
    assert.match(findModelMismatch(agentHostModel, served)!, /Agent 'github.copilot.editsAgent'/);
  });

  it('rejects a response that reports another model', () => {
    const served = { modelId: 'copilot/model-b', agentId: 'github.copilot.editsAgent', details: 'Default Model • 1x' };
    assert.match(findModelMismatch(localModel, served)!, /reports model 'Default Model'/);
  });

  it("doesn't treat a model whose name extends the expected name as a match", () => {
    const expected = { vendor: 'copilot', id: 'model-d', name: 'Model D' };
    const served = { modelId: 'copilot/model-d', agentId: 'github.copilot.editsAgent', details: 'Model D Mini • 1x' };
    assert.match(findModelMismatch(expected, served)!, /reports model 'Model D Mini'/);
  });

  it('rejects a request without a recorded model', () => {
    assert.match(findModelMismatch(localModel, { agentId: 'github.copilot.editsAgent' })!, /didn't record/);
  });

  it('skips the details check when details are missing or the model is auto', () => {
    assert.equal(findModelMismatch(localModel, { modelId: 'copilot/model-b', agentId: 'github.copilot.editsAgent' }), undefined);
    const auto = { vendor: 'copilot', id: 'auto', name: 'Auto' };
    assert.equal(findModelMismatch(auto, { modelId: 'copilot/auto', details: 'Model A • 1x' }), undefined);
  });
});

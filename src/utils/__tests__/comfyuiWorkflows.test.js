import { describe, it, expect } from 'vitest';
import { buildTattooRemovalWorkflow, TATTOO_ONLY_OUTPUT_NODE_ID } from '../comfyuiWorkflows';

describe('buildTattooRemovalWorkflow', () => {
  it('returns a valid workflow object', () => {
    const wf = buildTattooRemovalWorkflow('input.png', 'mask.png');
    expect(typeof wf).toBe('object');
    expect(wf).not.toBeNull();
  });

  it('sets image and mask filenames', () => {
    const wf = buildTattooRemovalWorkflow('photo.png', 'tattoo_mask.png');
    expect(wf['1'].inputs.image).toBe('photo.png');
    expect(wf['2'].inputs.tattoo_mask || wf['2'].inputs.image).toBe('tattoo_mask.png');
  });

  it('uses default parameters', () => {
    const wf = buildTattooRemovalWorkflow('img.png', 'mask.png');
    const sampler = wf['13'].inputs;
    expect(sampler.steps).toBe(28);
    expect(sampler.denoise).toBe(1);
    expect(typeof sampler.seed).toBe('number');
  });

  it('accepts custom options', () => {
    const wf = buildTattooRemovalWorkflow('img.png', 'mask.png', {
      steps: 10,
      seed: 42,
      guidance: 5,
    });
    expect(wf['13'].inputs.steps).toBe(10);
    expect(wf['13'].inputs.seed).toBe(42);
    expect(wf['12'].inputs.guidance).toBe(5);
  });

  it('includes the output node', () => {
    const wf = buildTattooRemovalWorkflow('img.png', 'mask.png');
    expect(wf[TATTOO_ONLY_OUTPUT_NODE_ID]).toBeDefined();
    expect(wf[TATTOO_ONLY_OUTPUT_NODE_ID].class_type).toBe('SaveImage');
  });

  it('has correct model references', () => {
    const wf = buildTattooRemovalWorkflow('img.png', 'mask.png');
    expect(wf['3'].class_type).toBe('UNETLoader');
    expect(wf['4'].class_type).toBe('DualCLIPLoader');
    expect(wf['5'].class_type).toBe('VAELoader');
    expect(wf['6'].class_type).toBe('LoraLoader');
  });

  it('includes positive and negative prompts', () => {
    const wf = buildTattooRemovalWorkflow('img.png', 'mask.png');
    const positive = wf['8'].inputs.text;
    const negative = wf['9'].inputs.text;
    expect(positive).toContain('skin');
    expect(negative).toContain('tattoo');
  });

  it('applies custom lora strength', () => {
    const wf = buildTattooRemovalWorkflow('img.png', 'mask.png', { loraStrength: 0.5 });
    expect(wf['6'].inputs.strength_model).toBe(0.5);
    expect(wf['6'].inputs.strength_clip).toBe(0.5);
  });
});

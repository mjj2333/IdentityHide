/**
 * ComfyUI workflow builders for Redact.ID.
 * Generates API-format workflow JSON for tattoo removal.
 */

const DEFAULT_STEPS = 28;
const DEFAULT_GUIDANCE = 10;
const DEFAULT_DENOISE = 1;
const DEFAULT_LORA_STRENGTH = 0.8;
const SEED_MAX = 2 ** 53;

/**
 * Build the Flux Fill tattoo removal workflow with ultrarealistic LoRA.
 * @param {string} imageName - Uploaded image filename (from ComfyUI upload)
 * @param {string} maskName - Uploaded mask filename
 * @param {object} options - { seed, steps, guidance, denoise, loraStrength }
 */
export function buildTattooRemovalWorkflow(imageName, maskName, options = {}) {
  const {
    seed = Math.floor(Math.random() * SEED_MAX),
    steps = DEFAULT_STEPS,
    guidance = DEFAULT_GUIDANCE,
    denoise = DEFAULT_DENOISE,
    loraStrength = DEFAULT_LORA_STRENGTH,
  } = options;

  return {
    "1": {
      "class_type": "LoadImage",
      "inputs": { "image": imageName },
    },
    "2": {
      "class_type": "LoadImage",
      "inputs": { "image": maskName },
    },
    "3": {
      "class_type": "UNETLoader",
      "inputs": {
        "unet_name": "flux1-fill-dev-fp8.safetensors",
        "weight_dtype": "fp8_e4m3fn",
      },
    },
    "4": {
      "class_type": "DualCLIPLoader",
      "inputs": {
        "clip_name1": "clip_l.safetensors",
        "clip_name2": "t5xxl_fp8_e4m3fn.safetensors",
        "type": "flux",
        "device": "default",
      },
    },
    "5": {
      "class_type": "VAELoader",
      "inputs": { "vae_name": "ae.safetensors" },
    },
    // LoRA: ultrarealistic photo quality for natural skin/anatomy
    "6": {
      "class_type": "LoraLoader",
      "inputs": {
        "lora_name": "flux\\UltraRealPhoto.safetensors",
        "strength_model": loraStrength,
        "strength_clip": loraStrength,
        "model": ["3", 0],
        "clip": ["4", 0],
      },
    },
    "8": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": "bare clean skin, natural human body, anatomically correct hands with five fingers, correct finger count, correct toe count, natural joint anatomy, seamless continuation of surrounding skin tone and texture, matching skin color and lighting, photorealistic, high detail, 8k",
        "clip": ["6", 1],
      },
      "_meta": { "title": "Positive Prompt" },
    },
    "9": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": "extra fingers, missing fingers, fused fingers, deformed hands, extra hands, mutated hands, extra toes, missing toes, deformed feet, extra limbs, missing limbs, malformed limbs, fused joints, unnatural anatomy, tattoo, ink, drawing, text, watermark, blurry, low quality, distorted skin, discolored patch",
        "clip": ["6", 1],
      },
      "_meta": { "title": "Negative Prompt" },
    },
    "10": {
      "class_type": "InpaintModelConditioning",
      "inputs": {
        "noise_mask": true,
        "positive": ["8", 0],
        "negative": ["9", 0],
        "vae": ["5", 0],
        "pixels": ["1", 0],
        "mask": ["20", 0],
      },
    },
    "12": {
      "class_type": "FluxGuidance",
      "inputs": {
        "guidance": guidance,
        "conditioning": ["10", 0],
      },
    },
    "13": {
      "class_type": "KSampler",
      "inputs": {
        "seed": seed,
        "steps": steps,
        "cfg": 1,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": denoise,
        "model": ["6", 0],
        "positive": ["12", 0],
        "negative": ["10", 1],
        "latent_image": ["10", 2],
      },
    },
    "14": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": ["13", 0],
        "vae": ["5", 0],
      },
    },
    "15": {
      "class_type": "SaveImage",
      "inputs": {
        "filename_prefix": "Redact.ID_Inpaint",
        "images": ["14", 0],
      },
    },
    // Convert uploaded mask image to mask channel
    "20": {
      "class_type": "ImageToMask",
      "inputs": {
        "channel": "red",
        "image": ["2", 0],
      },
    },
  };
}

/** Output node ID for downloading the tattoo removal result */
export const TATTOO_ONLY_OUTPUT_NODE_ID = "15";

/**
 * Local VLM pipeline (DeepHat, llama.cpp multimodal endpoint on :11435).
 * GUARD-RAIL: this module is the only place allowed to look at an image
 * payload. It must never return raw base64 — only text safe to inline into
 * the R1 prompt (a technical description, or a clean fallback tag).
 */
import { isDeepHatAlive } from './deephat.js';

const DEEPHAT_URL = process.env.DEEPHAT_URL || 'http://127.0.0.1:11435';
const VLM_TIMEOUT_MS = parseInt(process.env.DEEPHAT_VLM_TIMEOUT_MS || '45000', 10);

const VLM_SYSTEM_PROMPT = process.env.DEEPHAT_VISION_SYSTEM_PROMPT ||
  'You are a visual analysis engine embedded in a coding agent pipeline. ' +
  'Describe the image with maximum technical fidelity: UI elements, visible text, ' +
  'error messages, stack traces, diagrams, layout structure, code snippets. ' +
  'Be concise but complete. Output ONLY the description, no preamble or disclaimers.';

function guessLabel(imageUrl, index) {
  const mimeMatch = /^data:image\/(\w+);base64,/i.exec(imageUrl || '');
  const ext = mimeMatch ? mimeMatch[1].toLowerCase() : 'png';
  return `imagem_${index + 1}.${ext}`;
}

/**
 * Sends an image to the local VLM and returns a technical text description.
 * Returns null if the VLM is offline or the request fails — callers must
 * supply a text fallback in that case.
 */
export async function describeImage(imageUrl, { hint = '' } = {}) {
  if (!imageUrl) return null;

  const alive = await isDeepHatAlive();
  if (!alive) return null;

  try {
    const response = await fetch(`${DEEPHAT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deephat',
        messages: [
          { role: 'system', content: VLM_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: hint || 'Descreva esta imagem com máximo detalhe técnico.' },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ],
        temperature: 0.2,
        max_tokens: 400,
        stream: false
      }),
      signal: AbortSignal.timeout(VLM_TIMEOUT_MS)
    });

    if (!response.ok) {
      console.warn(`[Vision] DeepHat VLM returned HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.warn(`[Vision] DeepHat VLM call failed: ${err.message}`);
    return null;
  }
}

/**
 * Resolves a single OpenAI-style content part (image_url/image) into a safe
 * text block for the R1 prompt. Never returns the raw base64/URL payload.
 */
export async function resolveImagePart(part, index = 0) {
  const imageUrl = part?.image_url?.url || part?.url || null;
  const label = guessLabel(imageUrl, index);

  if (!imageUrl) {
    return `[ATTACHED IMAGE: <${label}> (payload ausente ou malformado)]`;
  }

  const description = await describeImage(imageUrl);

  if (description) {
    return `[VISUAL CONTEXT: ${label}]\n${description}`;
  }

  return `[ATTACHED IMAGE: <${label}> (VLM offline - processamento visual indisponível)]`;
}

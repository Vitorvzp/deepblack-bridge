// language: JavaScript, file: cli/deephat.js, target: Node.js (ESM), Windows/Linux
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const DEEPHAT_URL = process.env.DEEPHAT_URL || 'http://127.0.0.1:11435';

/**
 * Queries DeepHat 7B llama.cpp server for health, props, and slots
 */
export async function getDeepHatStatus(baseUrl = DEEPHAT_URL) {
  const startTime = Date.now();
  const result = {
    alive: false,
    latencyMs: 0,
    health: null,
    modelName: 'DeepHat 7B',
    quantType: 'Q4_K',
    contextLength: 8192,
    totalSlots: 1,
    isProcessing: false,
    promptTokens: 0,
    buildInfo: '-'
  };

  try {
    const healthRes = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(1500)
    });
    result.latencyMs = Date.now() - startTime;
    if (healthRes.ok) {
      result.alive = true;
      result.health = await healthRes.json().catch(() => ({ status: 'ok' }));
    }
  } catch {
    result.alive = false;
    return result;
  }

  // Fetch /props
  try {
    const propsRes = await fetch(`${baseUrl}/props`, {
      signal: AbortSignal.timeout(1500)
    });
    if (propsRes.ok) {
      const props = await propsRes.json();
      if (props.model_alias) {
        // Extract clean file name from path
        const parts = props.model_alias.split(/[/\\]/);
        result.modelName = parts[parts.length - 1] || props.model_alias;
      }
      if (props.model_ftype) result.quantType = props.model_ftype;
      if (props.default_generation_settings?.n_ctx) {
        result.contextLength = props.default_generation_settings.n_ctx;
      }
      if (props.total_slots) result.totalSlots = props.total_slots;
      if (props.build_info) result.buildInfo = props.build_info;
    }
  } catch {}

  // Fetch /slots
  try {
    const slotsRes = await fetch(`${baseUrl}/slots`, {
      signal: AbortSignal.timeout(1500)
    });
    if (slotsRes.ok) {
      const slots = await slotsRes.json();
      if (Array.isArray(slots) && slots[0]) {
        result.isProcessing = Boolean(slots[0].is_processing);
        result.promptTokens = slots[0].n_prompt_tokens || 0;
      }
    }
  } catch {}

  return result;
}

/**
 * Queries GPU metrics via nvidia-smi
 */
export async function getGpuStatus() {
  try {
    const { stdout } = await execAsync(
      'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits',
      { timeout: 2500 }
    );

    const line = stdout.trim().split('\n')[0];
    if (!line) throw new Error('nvidia-smi retornou saída vazia');

    const [name, util, memUsed, memTotal, temp, pDraw, pLimit] = line.split(',').map(s => s.trim());

    const used = parseFloat(memUsed) || 0;
    const total = parseFloat(memTotal) || 1;
    const percent = (used / total) * 100;

    return {
      available: true,
      name: name || 'NVIDIA GPU',
      utilization: parseFloat(util) || 0,
      memoryUsed: used,
      memoryTotal: total,
      memoryPercent: percent,
      temperature: parseFloat(temp) || 0,
      powerDraw: pDraw ? parseFloat(pDraw) : null,
      powerLimit: pLimit ? parseFloat(pLimit) : null
    };
  } catch (err) {
    return {
      available: false,
      error: err.message || 'nvidia-smi não encontrado'
    };
  }
}

/**
 * Runs a quick tactical evaluation prompt with DeepHat 7B
 */
export async function testDeepHatInference(question = 'Identifique 2 vetores de bypass para WAF com header injection.', baseUrl = DEEPHAT_URL) {
  const startTime = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deephat',
        messages: [
          { role: 'system', content: 'You are DeepHat 7B, a concise technical security scout. Give 2 short bullet points.' },
          { role: 'user', content: question }
        ],
        temperature: 0.2,
        max_tokens: 120,
        stream: false
      }),
      signal: AbortSignal.timeout(30000)
    });

    const elapsed = Date.now() - startTime;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}`, durationMs: elapsed };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim() || 'Sem conteúdo retornado';
    const tokens = data.usage?.completion_tokens || 0;
    const tokensPerSec = tokens > 0 ? ((tokens / elapsed) * 1000).toFixed(1) : '-';

    return {
      ok: true,
      content,
      durationMs: elapsed,
      tokens,
      tokensPerSec
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      durationMs: Date.now() - startTime
    };
  }
}

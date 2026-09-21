/**
 * DeepHat 7B Secondary Context Advisor
 * Connects to local model server running on port 11435.
 * Observes tool outputs and requests in background to synthesize concise advisory points.
 */

const DEEPHAT_URL = process.env.DEEPHAT_URL || 'http://127.0.0.1:11435';
const adviceCache = new Map(); // sessionId -> { text, timestamp, target }
let isAnalyzing = false;

/**
 * Checks if DeepHat 7B server is responsive
 */
export async function isDeepHatAlive() {
  try {
    const res = await fetch(`${DEEPHAT_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'ok' || data.status === 'ready';
  } catch {
    return false;
  }
}

/**
 * Asynchronously analyzes incoming context (tool output or user prompt) with DeepHat 7B.
 * Fire-and-forget background worker.
 */
export function enqueueDeepHatObservation(sessionId, role, rawContent) {
  if (!sessionId || !rawContent) return;
  if (typeof rawContent !== 'string') {
    try { rawContent = JSON.stringify(rawContent); } catch { return; }
  }

  // Avoid running multiple concurrent analyses if GPU is busy
  if (isAnalyzing) return;

  // Filter out trivial outputs
  const trimmed = rawContent.trim();
  if (trimmed.length < 20) return;

  // Focus on the most informative chunk (up to 1500 chars)
  const truncated = trimmed.length > 1500 ? trimmed.slice(0, 1500) + '\n...[truncated]' : trimmed;

  // Run in background without awaiting
  (async () => {
    isAnalyzing = true;
    try {
      const alive = await isDeepHatAlive();
      if (!alive) return;

      const systemPrompt = process.env.DEEPHAT_SYSTEM_PROMPT || 
        'You are DeepHat, an autonomous background context advisor to the primary orchestrator.\n' +
        'STRICT OPERATIONAL RULES:\n' +
        '1. Ground every observation strictly in the provided execution output or text.\n' +
        '2. If the output is a script execution, tool output, or error, analyze the return code, logs, or payload directly.\n' +
        '3. Provide 1-2 concrete, verifiable technical observations or recommended next actions.\n' +
        '4. Output ONLY 2 concise bullet points. No filler, no disclaimers.';

      const userPrompt = `[OBSERVED ${role.toUpperCase()} OUTPUT]:\n${truncated}\n\nTechnical ground-truth analysis & next tactical move:`;

      const response = await fetch(`${DEEPHAT_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deephat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          max_tokens: 100,
          stream: false
        }),
        signal: AbortSignal.timeout(45000)
      });

      if (!response.ok) return;
      const data = await response.json();
      const advice = data.choices?.[0]?.message?.content?.trim();

      if (advice && advice.length > 10) {
        adviceCache.set(sessionId, {
          text: advice,
          timestamp: Date.now()
        });
        console.log(`[DeepHat 7B Intel] -> ${advice.replace(/\r?\n/g, ' | ')}`);
      }
    } catch (err) {
      // Background scout errors do not interrupt main execution
      console.warn(`[DeepHat 7B Warning] Background analysis skipped: ${err.message}`);
    } finally {
      isAnalyzing = false;
    }
  })();
}

/**
 * Consumes the latest DeepHat tactical advice for a session if available.
 * Clears the cache entry so advice is not repeated identically.
 */
export function consumeDeepHatAdvice(sessionId) {
  if (!sessionId) return null;
  const entry = adviceCache.get(sessionId);
  if (!entry) return null;

  // Advice expires after 3 minutes if not consumed
  if (Date.now() - entry.timestamp > 180000) {
    adviceCache.delete(sessionId);
    return null;
  }

  adviceCache.delete(sessionId);
  return entry.text;
}

/**
 * Direct on-demand consultation for DeepHat 7B (when the agent asks for a second opinion)
 */
export async function consultDeepHatDirect(question, context = '') {
  const alive = await isDeepHatAlive();
  if (!alive) {
    return 'DeepHat 7B assistant is currently offline or unreachable on port 11435.';
  }

  const promptContent = context 
    ? `Context:\n${context.slice(0, 2000)}\n\nQuestion / Objective:\n${question}`
    : question;

  const response = await fetch(`${DEEPHAT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deephat',
      messages: [
        {
          role: 'system',
          content: 'You are DeepHat 7B, an offensive security reasoning advisor. Provide concise, actionable technical vectors directly.'
        },
        { role: 'user', content: promptContent }
      ],
      temperature: 0.3,
      max_tokens: 180,
      stream: false
    }),
    signal: AbortSignal.timeout(75000)
  });

  if (!response.ok) {
    return `DeepHat 7B returned HTTP error: ${response.statusText}`;
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || 'No response from DeepHat.';
}

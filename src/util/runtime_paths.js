import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execName = path.basename(process.execPath).toLowerCase();
const isCompiledBinary = !['bun.exe', 'bun', 'node.exe', 'node'].includes(execName);

// Resolve um path persistente (.env, contas, sessoes, rate-limit) relativo a
// raiz real do projeto em dev/testes (node/bun run), ou relativo ao
// diretorio do .exe quando compilado. import.meta.dirname/__dirname mentem
// sobre isso dentro de um binario compilado pelo Bun -- apontam pra um path
// virtual embutido (ex: B:\~BUN\root no Windows), nao pro diretorio real
// onde o .exe foi colocado. process.execPath e o unico jeito confiavel de
// achar o diretorio real do .exe nesse caso.
export function resolveFromRoot(importMetaUrl, ...segments) {
  const base = isCompiledBinary
    ? path.dirname(process.execPath)
    : path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
  return path.join(base, ...segments);
}

# DeepBlack Gateway

> **High-Performance Local OpenAI-Compatible Gateway & Protocol Adapter for DeepSeek Models**  
> Exposes a standard OpenAI-compatible API (`/v1/chat/completions`) connected directly to DeepSeek services. Enables seamless integration with coding agents such as **DeepCode**, **OpenCode**, and custom AI workflows, with full support for reasoning streams (`reasoning_content`) and native tool execution.

---

## ⚡ Architecture Overview

DeepBlack acts as an intelligent protocol adapter between local development tools and the DeepSeek model endpoints:

1. **OpenAI Compatibility Layer**:
   - Standard `/v1/chat/completions` and `/v1/models` HTTP endpoints.
   - Streaming SSE support compliant with the OpenAI specification.
   - Dual model routing: `deepseek-reasoner` (R1 with CoT) and `deepseek-chat` (V3).

2. **Cryptographic Validation Engine (WASM)**:
   - High-throughput WebAssembly client challenge module ([`wasm/sha3_wasm.wasm`](./wasm/sha3_wasm.wasm)).
   - Resolves required client-side cryptographic puzzles in ~15-30ms using optimized Keccak/SHA3 routines.

3. **Stream Multiplexer & Tool Translation**:
   - Parses streaming JSON chunks, isolating `THINK` (chain-of-thought) from `RESPONSE` (final answer).
   - Seamlessly converts DSML invocation blocks into standard `delta.tool_calls` payloads.
   - Enables agents to execute local commands (`bash`, `read`, `edit`, `grep`, `glob`) and continue execution loops automatically.

---

## 🚀 Getting Started

### 1. Installation

Install project dependencies:

```bash
npm install
```

### 2. Configuration

Ensure your `.env` contains your active session credentials:

```env
PORT=5050
DEEPSEEK_TOKEN=your_jwt_token_here
DEEPSEEK_DEVICE_ID=your_device_id_here
```

### 3. Running the Gateway

Start the local service:

```bash
npm start
```

Or using background process management:

```bash
pm2 start src/server.js --name deepblack
```

The gateway listens locally on `http://127.0.0.1:5050`, exposing the OpenAI API at `http://127.0.0.1:5050/v1`.

---

## 🖥️ Management & Tools

- **Web Dashboard**: Access `http://127.0.0.1:5050/dashboard` in your browser for real-time traffic monitoring, token rates, and active sessions.
- **Terminal CLI**: Run `npm run cli` for terminal-based status and session tracking.
- **Automated Tests**: Run `npm test` or `node tests/test_server_complete.js` to verify gateway connectivity.

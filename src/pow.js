import fs from 'node:fs';
import { resolveFromRoot } from './util/runtime_paths.js';

let wasmInstance = null;
let wasmExports = null;
let wasmMemory = null;
const textEncoder = new TextEncoder();

export async function initWasm(customPath) {
  if (wasmExports) return wasmExports;

  const wasmPath = customPath || resolveFromRoot(import.meta.url, 'wasm', 'sha3_wasm.wasm');
  const wasmBytes = fs.readFileSync(wasmPath);
  const compiled = await WebAssembly.instantiate(wasmBytes, {});
  
  wasmInstance = compiled.instance;
  wasmExports = wasmInstance.exports;
  wasmMemory = new Uint8Array(wasmExports.memory.buffer);
  return wasmExports;
}

function getUint8Memory() {
  if (!wasmMemory || wasmMemory.byteLength === 0) {
    wasmMemory = new Uint8Array(wasmExports.memory.buffer);
  }
  return wasmMemory;
}

function passStringToWasm(arg, malloc, realloc) {
  const buf = textEncoder.encode(arg);
  const ptr = malloc(buf.length, 1) >>> 0;
  getUint8Memory().subarray(ptr, ptr + buf.length).set(buf);
  return { ptr, len: buf.length };
}

function getDataViewMemory() {
  return new DataView(wasmExports.memory.buffer);
}

/**
 * Solves the DeepSeekHashV1 PoW challenge.
 * @param {Object} challengeData - Challenge object from /create_pow_challenge
 * @returns {Promise<string>} Base64 encoded x-ds-pow-response header value
 */
export async function solveChallenge(challengeData) {
  await initWasm();

  const {
    algorithm = 'DeepSeekHashV1',
    challenge,
    salt,
    difficulty,
    expire_at: expireAt,
    signature,
    target_path: targetPath = '/api/v0/chat/completion'
  } = challengeData;

  if (algorithm !== 'DeepSeekHashV1') {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const prefix = `${salt}_${expireAt}_`;

  let retptr = 0;
  let answer = 0;

  try {
    retptr = wasmExports.__wbindgen_add_to_stack_pointer(-16);
    const { ptr: ptr0, len: len0 } = passStringToWasm(
      challenge,
      wasmExports.__wbindgen_export_0,
      wasmExports.__wbindgen_export_1
    );
    const { ptr: ptr1, len: len1 } = passStringToWasm(
      prefix,
      wasmExports.__wbindgen_export_0,
      wasmExports.__wbindgen_export_1
    );

    wasmExports.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);

    const r0 = getDataViewMemory().getInt32(retptr + 0, true);
    const r1 = getDataViewMemory().getFloat64(retptr + 8, true);

    if (r0 === 0) {
      throw new Error(`PoW solution not found for challenge: ${challenge}`);
    }
    answer = r1;
  } finally {
    if (retptr) {
      wasmExports.__wbindgen_add_to_stack_pointer(16);
    }
  }

  const responsePayload = {
    algorithm,
    challenge,
    salt,
    answer,
    signature,
    target_path: targetPath
  };

  const jsonStr = JSON.stringify(responsePayload);
  return Buffer.from(jsonStr).toString('base64');
}

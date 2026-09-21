import assert from 'node:assert';

export function parseToolCallsFromText(text) {
  const toolCalls = [];

  // 1. Check for DeepSeek DSML tool calls
  // <｜｜DSML｜｜ invoke name="tool_name">
  // <｜｜DSML｜｜ parameter name="arg_name" string="true">value</｜｜DSML｜｜ parameter>
  // </｜｜DSML｜｜ invoke>
  const dsmlInvokeRegex = /<[|｜]{2}DSML[|｜]{2}\s*invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}\s*invoke>/g;
  let match;
  let idx = 0;

  while ((match = dsmlInvokeRegex.exec(text)) !== null) {
    const name = match[1];
    const paramsBlock = match[2];
    const args = {};

    const paramRegex = /<[|｜]{2}DSML[|｜]{2}\s*parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[|｜]{2}DSML[|｜]{2}\s*parameter>/g;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
      const pName = pMatch[1];
      let pVal = pMatch[2].trim();
      try {
        pVal = JSON.parse(pVal);
      } catch {
        // keep as string
      }
      args[pName] = pVal;
    }

    toolCalls.push({
      index: idx++,
      id: `call_dsml_${Date.now()}_${idx}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    });
  }

  // 2. Check for standard JSON <tool_call> blocks
  if (toolCalls.length === 0) {
    const jsonCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
    while ((match = jsonCallRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        toolCalls.push({
          index: idx++,
          id: `call_json_${Date.now()}_${idx}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || {})
          }
        });
      } catch {}
    }
  }

  return toolCalls;
}

// Unit test
const sampleDSML = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read">
<｜｜DSML｜｜ parameter name="filePath" string="true">C:\\Users\\vitor\\Documents\\Dev\\My\\DeepBlack\\package.json</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

const parsed = parseToolCallsFromText(sampleDSML);
console.log('Parsed DSML:', parsed);

assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].function.name, 'read');
const args = JSON.parse(parsed[0].function.arguments);
assert.strictEqual(args.filePath, 'C:\\Users\\vitor\\Documents\\Dev\\My\\DeepBlack\\package.json');

console.log('✔ DSML parser unit test passed!');

import { parseToolCallsFromText, transformWslCommand } from '../src/server.js';

// All critical messages from session-ses_f4d9.md:
const tests = [
  {
    name: 'Msg 638 (vps_ports.sh with filePath"string" and </write>)',
    text: `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ filePath"string">C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\vps_ports.sh</｜｜DSML｜｜>
<｜｜DSML｜｜ parameter name="content" string="true">#!/bin/bash
ssh -i /home/vt/.ssh/id_ed25519_vps_new root@72.61.35.211
echo done
</｜｜DSML｜｜>
</｜｜DSML｜｜ write>
</｜｜DSML｜｜ calls>`
  },
  {
    name: 'Msg 652 (ports.sh with filePath"string" and </write>)',
    text: `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ filePath"string">C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\ports.sh</｜｜DSML｜｜>
<｜｜DSML｜｜ parameter name="content" string="true">for p in 80 443 8080 8443; do
  timeout 5 nc -z -w 4 179.127.11.60 $p && echo "$p OPEN" || echo "$p closed"
done
</｜｜DSML｜｜>
</｜｜DSML｜｜ write>
</｜｜DSML｜｜ calls>`
  },
  {
    name: 'Msg 552 (probe_sfp.py with parameter name="filePath" string="true")',
    text: `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="filePath" string="true">C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\probe_sfp.py</｜｜DSML｜｜>
<｜｜DSML｜｜ parameter name="content" string="true">import requests, warnings, time
print("ok")
</｜｜DSML｜｜>
</｜｜DSML｜｜ write>
</｜｜DSML｜｜ calls>`
  },
  {
    name: 'Msg 550 (command with #</｜｜DSML｜｜>)',
    text: `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="command">wsl -d kali-linux -- bash -lc "ssh -i key 'for p in 80 443; do nc \$p; done'" #</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`
  },
  {
    name: 'Msg with sfp_hex.py｜｜DSML｜｜> tag leak',
    text: `<｜｜DSML｜｜invoke name="write">
<｜｜DSML｜｜parameter name="filePath">C:\\temp\\sfp_hex.py｜｜DSML｜｜>
<｜｜DSML｜｜parameter name="content">import sys</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>`
  },
  {
    name: 'Standard <tool_call> with raw newlines in content',
    text: `<tool_call>
{
  "name": "write",
  "arguments": {
    "filePath": "C:\\temp\\check.py",
    "content": "line 1
line 2"
  }
}
</tool_call>`
  }
];

let failed = 0;
for (const t of tests) {
  const tools = parseToolCallsFromText(t.text);
  if (tools.length === 0) {
    console.error(`FAILED: ${t.name} -> got 0 tools!`);
    failed++;
  } else {
    console.log(`PASSED: ${t.name} -> tool: ${tools[0].function.name}`);
    const args = JSON.parse(tools[0].function.arguments);
    if (args.command) {
      console.log('   Command:', args.command.slice(0, 80) + '...');
    }
    if (args.filePath) {
      console.log('   FilePath:', args.filePath);
    }
  }
}

console.log(`\nTotal: ${tests.length}, Failed: ${failed}`);

import { parseToolCallsFromText } from '../src/server.js';

const msg820 = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ parameter name="command">wsl -d kali-linux -- bash -lc "cp /mnt/c/Users/vitor/AppData/Local/Temp/opencode/nvd_search.py /tmp/w3/ && cd /tmp/w3 && timeout 400 python3 nvd_search.py" #</｜｜DSML｜｜>
</｜｜DSML｜｜ calls>`;

console.log('Result of parsing msg820:');
console.log(JSON.stringify(parseToolCallsFromText(msg820), null, 2));

const msg786 = `<｜｜DSML｜｜ calls>
<invoke name="filePath">C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\tsch_sig.py</parameter>
<parameter name="content">from impacket.dcerpc.v5 import tsch
import inspect
for n in ("SchRpcEnumTasks"):
    pass
</parameter>
</invoke>
</｜｜DSML｜｜ calls>`;

console.log('\nResult of parsing msg786:');
console.log(JSON.stringify(parseToolCallsFromText(msg786), null, 2));

const msg738 = `<invoke name="write">
<parameter name="filePath">C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\introspect.py</parameter>
<parameter name="content">from impacket.dcerpc.v5 import srvs
u = [a for a in dir(srvs) if "UUID" in a.upper()]
print("UUIDs:", u)
</parameter>
</invoke>`;

console.log('\nResult of parsing msg738:');
console.log(JSON.stringify(parseToolCallsFromText(msg738), null, 2));

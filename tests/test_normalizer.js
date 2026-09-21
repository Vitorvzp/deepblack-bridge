function normalizeToolNameAndArgs(name, args) {
  let finalName = name;
  let finalArgs = { ...args };

  // If tool name is actually a parameter name
  if (finalName === 'filePath' || finalName === 'path' || finalName === 'file') {
    if (finalArgs.content || (finalArgs.input && finalArgs.input.includes('\n'))) {
      finalName = 'write';
    } else {
      finalName = 'read';
    }
  } else if (finalName === 'command' || finalName === 'cmd') {
    finalName = 'bash';
  }

  // If write is missing filePath or content, but has input
  if (finalName === 'write' && (!finalArgs.filePath || !finalArgs.content) && finalArgs.input) {
    const raw = finalArgs.input.trim();
    const firstNl = raw.indexOf('\n');
    if (firstNl !== -1) {
      if (!finalArgs.filePath) finalArgs.filePath = raw.slice(0, firstNl).trim();
      if (!finalArgs.content) finalArgs.content = raw.slice(firstNl + 1).trim();
      delete finalArgs.input;
    }
  }

  // If bash is missing command, but has input
  if (finalName === 'bash' && !finalArgs.command && finalArgs.input) {
    finalArgs.command = finalArgs.input;
    delete finalArgs.input;
  }

  return { name: finalName, args: finalArgs };
}

// Test 1: Msg 786 where DeepSeek wrote <invoke name="filePath">
const t1 = normalizeToolNameAndArgs('filePath', {
  input: 'C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\tsch_sig.py',
  content: 'from impacket import dcerpc'
});
console.log('Test 1 (Msg 786):', t1);

// Test 2: Msg 734 where write had all text dumped into input
const t2 = normalizeToolNameAndArgs('write', {
  input: 'C:\\Users\\vitor\\AppData\\Local\\Temp\\opencode\\introspect.py\nfrom impacket.dcerpc.v5 import srvs\nprint("hello")'
});
console.log('Test 2 (Msg 734):', t2);

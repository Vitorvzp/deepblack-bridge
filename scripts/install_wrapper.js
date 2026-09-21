#!/usr/bin/env node
// scripts/install_wrapper.js — compilado via Bun (`bun build --compile`) num
// .exe standalone. Embute Install.ps1 dentro do binario e chama o
// powershell.exe real da maquina pra executa-lo -- evita depender de
// modulos extras (tipo ps2exe) pra virar .exe.
//
// O path que `with { type: "file" }` retorna dentro de um binario COMPILADO
// e virtual (algo como B:\~BUN\root\...) -- so existe dentro do proprio
// processo Bun via Bun.file()/fs do Bun. powershell.exe e um processo
// externo separado (spawnSync), e nao enxerga esse path virtual — falha
// com "o arquivo nao existe". Por isso o conteudo precisa ser escrito de
// verdade num arquivo temporario em disco antes de invocar o powershell.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import installScriptFile from "./Install.ps1" with { type: "file" };

const workDir = mkdtempSync(join(tmpdir(), "deepblack-installer-"));
const realScriptPath = join(workDir, "Install.ps1");
writeFileSync(realScriptPath, await Bun.file(installScriptFile).text());

const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", realScriptPath],
  { stdio: "inherit" },
);

if (result.error) {
  console.error("Nao foi possivel iniciar o PowerShell:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

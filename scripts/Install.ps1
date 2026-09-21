# Install.ps1 - Instalador do DeepBlack Suite (DeepBlack bridge + DeepCode)
#
# Baixa os binarios direto das GitHub Releases (nao vem nada embutido nesse
# script -- ele so sabe os repos/tags). Enquanto os repos forem privados,
# isso so funciona se a pessoa rodando estiver autenticada via `gh auth
# login` com acesso a eles (ou os repos virarem publicos).

$ErrorActionPreference = "Stop"

$DeepBlackRepo = "Vitorvzp/deepblack-bridge"
$DeepCodeRepo  = "Vitorvzp/deepcode-cli"
$Tag           = "v0.1.0"
$InstallDir    = Join-Path $env:LOCALAPPDATA "DeepBlackSuite"

Write-Host "=== DeepBlack Suite Installer ===" -ForegroundColor Cyan
Write-Host "Instalando em: $InstallDir`n"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host "ERRO: GitHub CLI (gh) nao encontrado." -ForegroundColor Red
    Write-Host "Instale em https://cli.github.com/ e rode 'gh auth login' antes de continuar."
    exit 1
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "wasm") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "prompts") | Out-Null

$tmpZip = Join-Path $env:TEMP "deepblack-suite-$Tag.zip"

Write-Host "Baixando DeepBlack bridge ($DeepBlackRepo @ $Tag)..."
gh release download $Tag --repo $DeepBlackRepo --pattern "deepblack-suite-windows-x64.zip" --output $tmpZip --clobber
Expand-Archive -Path $tmpZip -DestinationPath $InstallDir -Force
Remove-Item $tmpZip -Force

Write-Host "Baixando DeepCode ($DeepCodeRepo @ $Tag)..."
gh release download $Tag --repo $DeepCodeRepo --pattern "deepcode.exe" --output (Join-Path $InstallDir "deepcode.exe") --clobber

# --- Adiciona ao PATH do usuario (sem duplicar) ---
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$InstallDir*") {
    Write-Host "Adicionando $InstallDir ao PATH do usuario..."
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
}

# --- Config do provider deepblack no opencode.jsonc ---
$configDir = Join-Path $env:USERPROFILE ".config\opencode"
$configPath = Join-Path $configDir "opencode.jsonc"
$providerBlock = @'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "deepblack/deepseek-reasoner",
  "small_model": "deepblack/deepseek-chat",
  "provider": {
    "deepblack": {
      "name": "DeepBlack (DeepSeek Web)",
      "options": {
        "baseURL": "http://127.0.0.1:5050/v1",
        "apiKey": "local"
      },
      "models": {
        "deepseek-reasoner": { "id": "deepseek-reasoner", "name": "DeepSeek R1 Reasoning Agent", "reasoning": true, "tool_call": true },
        "deepseek-chat": { "id": "deepseek-chat", "name": "DeepSeek V3 Chat", "reasoning": false, "tool_call": true }
      }
    }
  }
}
'@

if (-not (Test-Path $configPath)) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    Set-Content -Path $configPath -Value $providerBlock -Encoding utf8
    Write-Host "Config criada em $configPath"
} else {
    Write-Host "`nJa existe um opencode.jsonc em $configPath -- nao mexi nele." -ForegroundColor Yellow
    Write-Host "Adicione manualmente o bloco do provider 'deepblack' (baseURL http://127.0.0.1:5050/v1):"
    Write-Host $providerBlock
}

# --- Atalho de inicio (sobe a bridge minimizada, depois o DeepCode) ---
$startBat = @"
@echo off
start "" /min "%~dp0deepblack.exe"
timeout /t 2 /nobreak >nul
"%~dp0deepcode.exe"
"@
Set-Content -Path (Join-Path $InstallDir "Start DeepBlack Suite.bat") -Value $startBat -Encoding ascii

# --- Instrucoes ---
$leiame = @"
DeepBlack Suite -- passo a passo
=================================

Sincronizacao automatica da conta DeepSeek (zero cliques depois de
configurado -- roda sozinho a cada login, para sempre):

  1. Instale a extensao Tampermonkey (se ainda nao tiver):
     https://www.tampermonkey.net/
     (o instalador ja abriu essa pagina pra voce -- so clicar em
     "Adicionar ao Chrome/Edge")

  2. O instalador tambem abriu o arquivo do script diretamente no
     navegador. Com o Tampermonkey ativo, ele detecta sozinho que e um
     userscript e mostra um botao "Install" -- clique nele. (Se a aba nao
     abriu ou fechou sem querer, arraste este arquivo pra dentro de uma
     janela do navegador:
     $InstallDir\deepblack_autocapture.user.js)

  3. Faca login normalmente em https://chat.deepseek.com (o instalador
     ja abriu essa aba tambem). A partir dai, toda vez que voce logar
     nesse site, sua conta sincroniza sozinha com o DeepBlack -- sem
     precisar clicar em mais nada.

Alternativa sem instalar extensao nenhuma (mas exige 1 clique manual
sempre que quiser sincronizar): $InstallDir\bookmarklet.html

Depois de sincronizar pelo menos uma vez:

- Use o atalho "Start DeepBlack Suite.bat" (nesta pasta) pra iniciar a
  bridge e o DeepCode juntos, ou rode `deepcode` de qualquer terminal
  (o instalador ja adicionou essa pasta ao PATH).

Nada de credenciais veio junto com essa instalacao -- cada conta e a sua,
capturada localmente quando voce loga.
"@
Set-Content -Path (Join-Path $InstallDir "LEIA-ME.txt") -Value $leiame -Encoding utf8

Write-Host "`n=== Instalacao concluida ===" -ForegroundColor Green
Write-Host "Abrindo as 3 abas que voce precisa pra terminar a configuracao"
Write-Host "(instalar Tampermonkey, instalar o script, logar no DeepSeek)...`n"

# Start-Process num caminho de arquivo local usa a associacao de tipo de
# arquivo do Windows pra decidir o que abrir -- .js esta associado ao
# Windows Script Host (wscript.exe) por padrao, NAO ao navegador. Resolver
# e chamar o executavel do navegador padrao diretamente evita isso (testado
# e confirmado: abre corretamente como aba do navegador).
function Get-DefaultBrowserExe {
    try {
        $progId = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" -ErrorAction Stop).ProgId
        $cmdLine = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction Stop).'(default)'
        if ($cmdLine -match '"([^"]+)"') { return $matches[1] }
        return ($cmdLine -split ' ')[0]
    } catch {
        return $null
    }
}

$browserExe = Get-DefaultBrowserExe
$userScriptPath = Join-Path $InstallDir "deepblack_autocapture.user.js"

if ($browserExe -and (Test-Path $browserExe)) {
    Start-Process -FilePath $browserExe -ArgumentList "https://www.tampermonkey.net/"
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath $browserExe -ArgumentList $userScriptPath
    Start-Sleep -Milliseconds 500
    Start-Process -FilePath $browserExe -ArgumentList "https://chat.deepseek.com"
} else {
    Write-Host "(Nao consegui detectar o navegador padrao automaticamente -- abra manualmente:)" -ForegroundColor Yellow
    Write-Host "  https://www.tampermonkey.net/"
    Write-Host "  $userScriptPath"
    Write-Host "  https://chat.deepseek.com"
}

Write-Host "1. Na primeira aba: instale a extensao Tampermonkey (se ainda nao tiver)."
Write-Host "2. Na segunda aba: clique em 'Install' no prompt do Tampermonkey."
Write-Host "3. Na terceira aba: faca login normalmente -- a sincronizacao e automatica dai em diante."
Write-Host "`n(Passo a passo completo salvo em: $InstallDir\LEIA-ME.txt)"
Write-Host "`nDepois, use '$InstallDir\Start DeepBlack Suite.bat' pra iniciar tudo."
Write-Host "(Abra um terminal novo pra o PATH atualizado ter efeito.)"

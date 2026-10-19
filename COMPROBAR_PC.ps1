# Verificador de dependencias de Editor IRL (no bloquea el arranque)
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$warn = @()

# Node (portatil o del sistema)
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $node)) { if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $warn += 'Node.js no encontrado (deberia venir incluido).' } }

# FFmpeg / Whisper (incluidos en tools)
if (-not (Test-Path (Join-Path $root 'tools\ffmpeg.exe'))) { $warn += 'FFmpeg no encontrado en tools\.' }
if (-not (Test-Path (Join-Path $root 'tools\whisper-cli.exe'))) { $warn += 'Whisper no encontrado en tools\.' }

# GPU NVIDIA (opcional, acelera la transcripcion)
$gpu = $false
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $gpu = $true }
if ($gpu -and (Test-Path (Join-Path $root 'tools-gpu\whisper-cli.exe'))) {
  Write-Host 'GPU NVIDIA detectada: la transcripcion usara la GPU (mas rapida).' -ForegroundColor Green
} elseif (-not $gpu) {
  Write-Host 'Sin GPU NVIDIA: la transcripcion usara el CPU (mas lenta, pero funciona).' -ForegroundColor Yellow
}

# Ollama (opcional, para ganchos/titulos con IA)
if (Get-Command ollama -ErrorAction SilentlyContinue) {
  $models = (& ollama list) 2>$null
  if ($models -match 'gemma3:4b') {
    Write-Host 'Ollama + gemma3:4b listo: los Shorts tendran gancho/titulo con IA.' -ForegroundColor Green
  } else {
    Write-Host 'Ollama esta, pero falta el modelo. Ejecuta una vez:  ollama pull gemma3:4b' -ForegroundColor Yellow
  }
} else {
  Write-Host 'Ollama no esta instalado (opcional). Sin el, los Shorts se eligen por ritmo, sin gancho con IA.' -ForegroundColor Yellow
  Write-Host 'Para activarlo: instala Ollama (https://ollama.com) y luego:  ollama pull gemma3:4b' -ForegroundColor Yellow
}

foreach ($w in $warn) { Write-Host ("AVISO: " + $w) -ForegroundColor Red }
exit 0

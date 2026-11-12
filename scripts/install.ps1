param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$Workspace = 'C:\Users\34721\Documents\deepseek-harness\ComfyUI\plugins\dsh-comfyui-gallery',
  [string]$Profile = 'C:\Users\34721\.dsh\profiles\desktop'
)
$ErrorActionPreference = 'Stop'
$sourcePath = [IO.Path]::GetFullPath($Source)
$workspacePath = [IO.Path]::GetFullPath($Workspace)
$profilePath = [IO.Path]::GetFullPath($Profile)
$installedPath = Join-Path $profilePath 'plugins\dsh-comfyui-gallery'
if (!(Test-Path -LiteralPath (Join-Path $sourcePath 'lib\index.js'))) { throw 'Source plugin is incomplete' }
if (!(Test-Path -LiteralPath $profilePath)) { throw 'DSH profile does not exist' }
if ($sourcePath -ne $workspacePath) {
  New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null
  foreach ($name in @('lib','scripts','package.json','cordis.patch.yml','README.md','icon.svg')) {
    Copy-Item -LiteralPath (Join-Path $sourcePath $name) -Destination $workspacePath -Recurse -Force
  }
  $validation = Join-Path $sourcePath 'VALIDATION.md'
  if (Test-Path -LiteralPath $validation) {
    Copy-Item -LiteralPath $validation -Destination $workspacePath -Force
  }
}
if (!(Test-Path -LiteralPath $installedPath)) {
  New-Item -ItemType Junction -Path $installedPath -Target $workspacePath | Out-Null
} else {
  $installed = Get-Item -LiteralPath $installedPath
  if ($installed.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath([string]$installed.Target) -ne $workspacePath) { throw 'Existing plugin install differs; preserving it for manual review' }
}
$patchPath = Join-Path $profilePath 'cordis.patch.yml'
$content = [IO.File]::ReadAllText($patchPath)
$original = $content
$entry = './plugins/dsh-comfyui-gallery/lib/index.js'
if (!$content.Contains($entry)) {
  if ($content -match '(?m)^\s*- id: (ui-comfyui-gallery|dsh-comfyui-gallery)\s*$') { throw 'Gallery entry already exists with different wiring' }
  $content = $content.TrimEnd() + "`n`n# ui-comfyui-gallery: ComfyUI image gallery`n- insert:`n    - id: ui-comfyui-gallery`n      name: $entry`n"
}
$watch = '      - ./plugins/dsh-comfyui-gallery'
if (!$content.Contains($watch)) {
  $pattern = '(?ms)(^- id: hmr\r?\n(?:(?!^- ).)*?^    root:\r?\n)((?:^      - [^\r\n]*\r?\n)+)'
  $matches = [regex]::Matches($content, $pattern)
  if ($matches.Count -ne 1) { throw 'Expected exactly one existing hmr root list' }
  $content = [regex]::Replace($content, $pattern, { param($match) $match.Groups[1].Value + $match.Groups[2].Value + $watch + "`n" }, 1)
}
if ($content -ne $original) {
  $backup = $patchPath + '.gallery-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item -LiteralPath $patchPath -Destination $backup
  [IO.File]::WriteAllText($patchPath, $content, [Text.UTF8Encoding]::new($false))
  Write-Output "Profile backup: $backup"
}
Write-Output "Workspace: $workspacePath"
Write-Output "Installed junction: $installedPath"
Write-Output 'The existing HMR service will load the gallery entry.'

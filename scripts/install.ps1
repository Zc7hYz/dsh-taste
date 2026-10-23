<#
.SYNOPSIS
  安装 / 卸载 dsh-taste 插件到 DSH 桌面版（desktop profile）。
.DESCRIPTION
  幂等三步：补插件依赖 → profile 登记 dependency(link:) 与 bundles → node_modules junction。
  改完必须重启 DSH 桌面版（插件在启动时加载）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -Uninstall
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -ProfileName desktop-check
#>
[CmdletBinding()]
param(
  [string]$PluginPath = "",
  [string]$ProfileName = 'desktop',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null; [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

if (-not $PluginPath) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  if (-not $here) { throw '无法定位插件目录，请显式传 -PluginPath <插件根目录>' }
  $PluginPath = Split-Path -Parent $here
}$PkgName  = 'dsh-taste'
$dshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile  = Join-Path $dshHome ('profiles\' + $ProfileName)
$pkgFile  = Join-Path $profile 'package.json'
$linkPath = Join-Path $profile ('node_modules\' + $PkgName)

if (-not (Test-Path $pkgFile)) { throw "找不到 profile: $pkgFile（先启动一次 DSH 桌面版）" }
if (-not (Test-Path (Join-Path $PluginPath 'lib\index.js'))) { throw "插件目录不对: $PluginPath" }

function Get-NodeExe {
  $c = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $c) { return $c }
  return 'node'
}
function Get-PnpmCjs {
  $c = Join-Path $dshHome 'dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
  if (Test-Path $c) { return $c }
  return $null
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
Copy-Item $pkgFile "$pkgFile.$stamp.bak" -Force
Write-Host "已备份 profile/package.json → package.json.$stamp.bak"

function Read-Profile { [IO.File]::ReadAllText($pkgFile, [Text.Encoding]::UTF8) | ConvertFrom-Json }
function Write-Profile($obj) {
  [IO.File]::WriteAllText($pkgFile, ($obj | ConvertTo-Json -Depth 30), (New-Object Text.UTF8Encoding($false)))
}

if ($Uninstall) {
  if (Test-Path $linkPath) { cmd /c rmdir "$linkPath" | Out-Null; Write-Host "已删除 node_modules\$PkgName" }
  $obj = Read-Profile
  if ($obj.dsh.profile.bundles) { $obj.dsh.profile.bundles = @($obj.dsh.profile.bundles) | Where-Object { $_ -ne $PkgName } }
  if ($obj.dependencies -and ($obj.dependencies.PSObject.Properties.Name -contains $PkgName)) {
    $obj.dependencies.PSObject.Properties.Remove($PkgName)
  }
  Write-Profile $obj
  Write-Host "已从 profile 移除 $PkgName。重启 DSH 桌面版后生效。" -ForegroundColor Yellow
  return
}

# 1) 插件自身依赖
$depMarker = Join-Path $PluginPath 'node_modules\@deepseek-ai\dsh-tools'
if (-not (Test-Path $depMarker)) {
  $node = Get-NodeExe
  $pnpm = Get-PnpmCjs
  if ($pnpm) {
    Write-Host '安装插件依赖 (pnpm)...'
    Push-Location $PluginPath
    try { & $node $pnpm install --registry=https://registry.npmmirror.com --ignore-scripts --reporter=append-only }
    finally { Pop-Location }
  } else {
    Write-Warning '未找到 pnpm：请在插件目录手动执行 npm install（或 pnpm install）后重跑本脚本'
  }
}

# 2) profile 登记
$obj = Read-Profile
$changed = $false
if (-not $obj.dependencies) { $obj | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force; $changed = $true }
if (-not ($obj.dependencies.PSObject.Properties.Name -contains $PkgName)) {
  $obj.dependencies | Add-Member -NotePropertyName $PkgName -NotePropertyValue ('link:' + ($PluginPath -replace '\\', '/'))
  $changed = $true
  Write-Host "已登记 dependency: $PkgName → link:$PluginPath"
}
if (-not $obj.dsh) { $obj | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } }); $changed = $true }
if (-not $obj.dsh.profile) { $obj.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{ bundles = @() }); $changed = $true }
$bundles = @($obj.dsh.profile.bundles | Where-Object { $_ })
if ($bundles -notcontains $PkgName) {
  $obj.dsh.profile.bundles = @($bundles) + $PkgName
  $changed = $true
  Write-Host "已登记 bundles: $PkgName"
}
if ($changed) { Write-Profile $obj }

# 3) junction
if (-not (Test-Path $linkPath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $linkPath) | Out-Null
  cmd /c mklink /J "$linkPath" "$PluginPath" | Out-Null
  Write-Host "已建立 junction → $PluginPath"
} else {
  Write-Host 'junction 已存在，跳过'
}

# 4) 资产自检
$skillRoot = Join-Path $dshHome 'skills\impeccable'
if (-not (Test-Path $skillRoot)) {
  Write-Warning "未找到 impeccable 技能目录 $skillRoot —— 先跑 scripts/setup-assets.ps1，否则 design_detect / design_playbook 不可用"
}
$stylesRoot = Join-Path $PluginPath 'assets\design-md'
if (-not (Test-Path $stylesRoot)) {
  Write-Warning "未找到风格库 $stylesRoot —— 先跑 scripts/setup-assets.ps1，否则 design_propose 无方案可选"
}

Write-Host ''
Write-Host '安装完成。重启 DSH 桌面版后生效（6 个 design_* 工具 + 会话设计规则）。' -ForegroundColor Green

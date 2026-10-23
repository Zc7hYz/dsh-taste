<#
.SYNOPSIS
  一键准备 dsh-taste 需要的两套外部资产（不随仓库分发，避免第三方版权与 20MB 二进制）。
.DESCRIPTION
  1) impeccable 引擎：从 GitHub Releases 下载 windows-x64 可执行文件，校验 sha256，
     再执行 `impeccable install --providers=dsh --user`，把技能与 41 篇细则装到
     %DSH_HOME%/skills/impeccable（含 61 条反模式扫描器）。
  2) 风格库：从 VoltAgent/awesome-design-md 拉 zip，抽出 design-md/ 到 插件目录/assets/design-md。
  国内网络可用 -Proxy 指定 gh 加速前缀（默认依次尝试直连、gh-proxy、ghfast）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-assets.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-assets.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$PluginPath = "",
  [string]$EngineVersion = '0.1.16',
  [string]$DesignMdRepo = 'VoltAgent/awesome-design-md',
  [string]$DesignMdRef = 'main',
  [string[]]$Proxy = @('', 'https://gh-proxy.com/', 'https://ghfast.top/'),
  [switch]$SkipImpeccable,
  [switch]$SkipStyles,
  [switch]$Force
)

if (-not $PluginPath) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  if (-not $here) { throw '无法定位插件目录，请显式传 -PluginPath <插件根目录>' }
  $PluginPath = Split-Path -Parent $here
}$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null; [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$assets  = Join-Path $PluginPath 'assets'
$tmp     = Join-Path $assets '_tmp'
New-Item -ItemType Directory -Force -Path $assets, $tmp | Out-Null

function Get-File([string]$Url, [string]$OutFile) {
  foreach ($p in $Proxy) {
    $full = $p + $Url
    try {
      Invoke-WebRequest -Uri $full -OutFile $OutFile -UseBasicParsing -TimeoutSec 300
      if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) {
        Write-Host ("  下载成功 [{0}]" -f ($(if ($p) { $p } else { '直连' }))) -ForegroundColor DarkGray
        return $true
      }
    } catch {
      Write-Verbose ("  失败: {0} -> {1}" -f $full, $_.Exception.Message)
    }
  }
  return $false
}

# ---------------------------------------------------------------- 1. 引擎
if (-not $SkipImpeccable) {
  Write-Host '[1/2] impeccable 引擎 + 技能细则' -ForegroundColor Cyan
  $exeDir = Join-Path $assets 'bin'
  $exe    = Join-Path $exeDir 'impeccable.exe'
  New-Item -ItemType Directory -Force -Path $exeDir | Out-Null

  if ($Force -or -not (Test-Path $exe)) {
    $base = "https://github.com/pbakaus/impeccable/releases/download/engine-v$EngineVersion/impeccable-windows-x64.exe"
    $sha  = "$exe.sha256"
    if (-not (Get-File $base $exe)) { throw "引擎下载失败：$base（可用 -Proxy 换加速源）" }
    if (Get-File "$base.sha256" $sha) {
      $expected = ([IO.File]::ReadAllText($sha)).Trim().Split(' ')[0].ToLower()
      $actual   = (Get-FileHash -Path $exe -Algorithm SHA256).Hash.ToLower()
      if ($expected -and $actual -ne $expected) {
        Remove-Item $exe -Force
        throw "引擎校验失败：expected $expected, got $actual"
      }
      Write-Host '  sha256 校验通过' -ForegroundColor DarkGray
    } else {
      Write-Warning '  拿不到 .sha256，跳过校验（官方安装器同样会拒绝未校验下载，请自行确认来源）'
    }
  } else {
    Write-Host '  引擎已存在，跳过下载（-Force 重新下载）'
  }

  $skillRoot = Join-Path $dshHome 'skills\impeccable'
  if ($Force -or -not (Test-Path (Join-Path $skillRoot 'SKILL.md'))) {
    Write-Host '  安装 DSH 技能（impeccable install --providers=dsh --user）...'
    & $exe install --providers=dsh --user --yes --force | Out-Host
  }
  if (-not (Test-Path (Join-Path $skillRoot 'SKILL.md'))) { throw "技能安装失败，未生成 $skillRoot\SKILL.md" }
  $refCount = (Get-ChildItem (Join-Path $skillRoot 'reference') -File -ErrorAction SilentlyContinue).Count
  Write-Host ("  技能目录: {0}（{1} 篇细则）" -f $skillRoot, $refCount) -ForegroundColor Green
}

# ---------------------------------------------------------------- 2. 风格库
if (-not $SkipStyles) {
  Write-Host '[2/2] DESIGN.md 风格库（84 套真实站点）' -ForegroundColor Cyan
  $dest = Join-Path $assets 'design-md'
  if ($Force -or -not (Test-Path $dest)) {
    $zip  = Join-Path $tmp 'design-md.zip'
    $url  = "https://codeload.github.com/$DesignMdRepo/zip/refs/heads/$DesignMdRef"
    if (-not (Get-File $url $zip)) { throw "风格库下载失败：$url" }
    $unzip = Join-Path $tmp 'design-md'
    if (Test-Path $unzip) { Remove-Item $unzip -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $unzip -Force
    $inner = Get-ChildItem $unzip -Directory | Select-Object -First 1
    $src   = Join-Path $inner.FullName 'design-md'
    if (-not (Test-Path $src)) { throw "压缩包结构异常：找不到 design-md/（$($inner.FullName)）" }
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $src $dest -Recurse -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host '  风格库已存在，跳过下载（-Force 重新下载）'
  }
  $n = (Get-ChildItem $dest -Directory -ErrorAction SilentlyContinue).Count
  Write-Host ("  风格库: {0}（{1} 套）" -f $dest, $n) -ForegroundColor Green
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
Write-Host '资产就绪。下一步：' -ForegroundColor Green
Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1'
Write-Host '  然后重启 DSH 桌面版。'

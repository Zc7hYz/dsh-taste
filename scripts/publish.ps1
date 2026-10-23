<#
.SYNOPSIS
  把 dsh-taste 发布到 GitHub（纯 REST API，不需要装 git）。
.DESCRIPTION
  1) 校验 token（GET /user）
  2) 创建仓库（已存在则复用）
  3) 逐个文件上传 / 更新（白名单：README/LICENSE/package.json/cordis.patch.yml/.gitignore + lib/ + scripts/）
  不传 assets/、node_modules/、pnpm-lock.yaml、*.bak —— 那些由 setup-assets.ps1 在用户机器上生成。
.EXAMPLE
  $env:GH_TOKEN = "ghp_xxxxxxxx"
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish.ps1 -Repo dsh-taste
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish.ps1 -Token ghp_xxx -Repo dsh-taste -Private
#>
[CmdletBinding()]
param(
  [string]$Token = $env:GH_TOKEN,
  [string]$Owner = '',
  [string]$Repo = 'dsh-taste',
  [string]$Description = 'DSH 界面设计插件：一句话给出多个气质不同的方案，按真实站点 DESIGN.md 的 token 实现，写完用 61 条规则自检。',
  [string]$PluginPath = '',
  [switch]$Private,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
try { chcp 65001 | Out-Null; [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $PluginPath) {
  $here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $PSCommandPath }
  if (-not $here) { throw '无法定位插件目录，请显式传 -PluginPath <插件根目录>' }
  $PluginPath = Split-Path -Parent $here
}
if (-not $Token) { throw '缺少 token：设置 $env:GH_TOKEN，或传 -Token ghp_xxx（需 repo 权限）' }

$Api = 'https://api.github.com'
$Headers = @{
  Authorization          = "Bearer $Token"
  'User-Agent'           = 'dsh-taste-publish'
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

function Invoke-Gh([string]$Method, [string]$Path, $Body) {
  $args = @{ Method = $Method; Uri = "$Api$Path"; Headers = $Headers; UseBasicParsing = $true; TimeoutSec = 120 }
  if ($null -ne $Body) {
    $args.Body = ($Body | ConvertTo-Json -Depth 10)
    $args.ContentType = 'application/json; charset=utf-8'
  }
  try {
    return Invoke-RestMethod @args
  } catch {
    $resp = $_.Exception.Response
    $detail = ''
    if ($resp) {
      try {
        $sr = New-Object IO.StreamReader($resp.GetResponseStream())
        $detail = $sr.ReadToEnd(); $sr.Close()
      } catch {}
    }
    throw "$Method $Path 失败: $($_.Exception.Message) $detail"
  }
}

# ------------------------------------------------------------------ 1. 身份
$me = Invoke-Gh 'GET' '/user' $null
if (-not $Owner) { $Owner = $me.login }
Write-Host ("认证通过：{0}（{1}）" -f $me.login, $me.name) -ForegroundColor Green
if ($me.login -ne $Owner -and -not $Owner) { throw '无法确定 owner' }

# ------------------------------------------------------------------ 2. 仓库
$repoExists = $false
try {
  $null = Invoke-Gh 'GET' "/repos/$Owner/$Repo" $null
  $repoExists = $true
  Write-Host "仓库已存在：$Owner/$Repo（将更新文件）" -ForegroundColor Yellow
} catch {
  if ($_.Exception.Message -notmatch '404') { throw }
}

if (-not $repoExists) {
  if ($DryRun) {
    Write-Host "[dry-run] 将创建仓库 $Owner/$Repo（private=$([bool]$Private)）"
  } else {
    $body = @{ name = $Repo; description = $Description; private = [bool]$Private; has_issues = $true; has_wiki = $false; auto_init = $false }
    $null = Invoke-Gh 'POST' '/user/repos' $body
    Write-Host "已创建仓库：$Owner/$Repo" -ForegroundColor Green
  }
}

# ------------------------------------------------------------------ 3. 文件清单
$rootFiles = @('README.md', 'LICENSE', 'package.json', 'cordis.patch.yml', '.gitignore')
$files = @()
foreach ($f in $rootFiles) {
  $p = Join-Path $PluginPath $f
  if (Test-Path $p) { $files += $p }
}
foreach ($dir in @('lib', 'scripts')) {
  $d = Join-Path $PluginPath $dir
  if (Test-Path $d) { $files += (Get-ChildItem $d -Recurse -File | ForEach-Object { $_.FullName }) }
}
$files = $files | Where-Object { $_ -notmatch '\.bak$' } | Sort-Object -Unique
if (-not $files) { throw "没找到可发布文件：$PluginPath" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$okCount = 0
$skipCount = 0

foreach ($file in $files) {
  $rel = ($file.Substring($PluginPath.Length).TrimStart('\', '/')) -replace '\\', '/'
  $bytes = [IO.File]::ReadAllBytes($file)
  $b64 = [Convert]::ToBase64String($bytes)

  if ($DryRun) {
    Write-Host ("[dry-run] {0}  ({1:N0} B)" -f $rel, $bytes.Length)
    $okCount++
    continue
  }

  $sha = $null
  try {
    $existing = Invoke-Gh 'GET' "/repos/$Owner/$Repo/contents/$rel" $null
    if ($existing -and $existing.sha) { $sha = $existing.sha }
  } catch {
    if ($_.Exception.Message -notmatch '404') { throw }
  }

  # 内容没变就不重复提交
  if ($sha) {
    $remote = Invoke-Gh 'GET' "/repos/$Owner/$Repo/contents/$rel" $null
    if ($remote.encoding -eq 'base64' -and ($remote.content -replace '\s', '') -eq $b64) {
      Write-Host ("  跳过（无变化） {0}" -f $rel) -ForegroundColor DarkGray
      $skipCount++
      continue
    }
  }

  $body = @{ message = "chore: sync $rel"; content = $b64 }
  if ($sha) { $body.sha = $sha }
  $null = Invoke-Gh 'PUT' "/repos/$Owner/$Repo/contents/$rel" $body
  Write-Host ("  上传 {0}  ({1:N0} B)" -f $rel, $bytes.Length) -ForegroundColor DarkGray
  $okCount++
}

$url = "https://github.com/$Owner/$Repo"
Write-Host ''
if ($DryRun) {
  Write-Host ("[dry-run] 共 {0} 个文件待上传 → {1}" -f $okCount, $url) -ForegroundColor Cyan
} else {
  Write-Host ("完成：上传/更新 {0} 个，跳过 {1} 个" -f $okCount, $skipCount) -ForegroundColor Green
  Write-Host "仓库：$url" -ForegroundColor Green
  Write-Host "克隆：git clone $url.git" -ForegroundColor Green
}

# 发布脚本（维护者工具）：从 plugins/ 源码构建 ZIP，发布为 GitHub Release 附件
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/publish-plugins.ps1                        发布全部有新版本的插件
#   powershell -ExecutionPolicy Bypass -File scripts/publish-plugins.ps1 -PluginId weather-tool 只发布指定插件
# 前置：已安装 gh CLI 并完成 gh auth login；合并插件 PR 后运行本脚本
# 规则：每个版本一个独立 Release（tag = <插件id>-<版本>），附件下载量由 GitHub 自动计数；
#       tag 已存在时跳过，绝不覆盖旧 Release（保留历史版本下载计数）。
#       本地 zips/ 目录只是发布中转，不提交进仓库（已加入 .gitignore）。

param(
    # 只发布指定插件 id；缺省遍历全部插件目录
    [string]$PluginId
)

$ErrorActionPreference = "Stop"
$Repo = "Playa-0v0/Cyrene-Plugins"
$root = Split-Path -Parent $PSScriptRoot
$pluginsDir = Join-Path $root "plugins"
$zipsDir = Join-Path $root "zips"
$registryPath = Join-Path $root "registry.json"
New-Item -ItemType Directory -Force $zipsDir | Out-Null

$registry = Get-Content $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$changed = $false

Get-ChildItem $pluginsDir -Directory | Where-Object { -not $PluginId -or $_.Name -eq $PluginId } | ForEach-Object {
    $manifestPath = Join-Path $_.FullName "manifest.json"
    if (-not (Test-Path $manifestPath)) {
        Write-Warning "跳过 $($_.Name)：缺少 manifest.json"
        return
    }
    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.id -ne $_.Name) {
        throw "$($_.Name)：目录名与 manifest id（$($manifest.id)）不一致，中止发布"
    }

    $entry = $registry.plugins | Where-Object { $_.id -eq $manifest.id }
    if (-not $entry) {
        throw "registry.json 中没有登记 $($manifest.id)，请先补登记再发布"
    }

    $tag = "$($manifest.id)-$($manifest.version)"
    # 幂等保护：该版本已发布过 Release 就跳过
    gh release view $tag --repo $Repo 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "跳过 ${tag}：Release 已存在"
        return
    }

    $zipName = "${tag}.zip"
    $zipPath = Join-Path $zipsDir $zipName
    # ZIP 内保留一层插件目录，与 GitHub「Download ZIP」形态一致，宿主导入逻辑支持
    Compress-Archive -Path $_.FullName -DestinationPath $zipPath -Force
    $sha256 = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host ("发布 {0}  ({1:N1} kB)  sha256={2}" -f $zipName, ((Get-Item $zipPath).Length / 1KB), $sha256)

    gh release create $tag $zipPath --title $tag --notes $manifest.description --repo $Repo
    if ($LASTEXITCODE -ne 0) {
        throw "gh release create ${tag} 失败"
    }

    # 回写索引：下载地址指向 Release 附件，附 SHA-256 供客户端校验完整性
    $entry.version = $manifest.version
    $entry.zip = "https://github.com/$Repo/releases/download/$tag/$zipName"
    $entry | Add-Member -NotePropertyName sha256 -NotePropertyValue $sha256 -Force
    $changed = $true
}

if ($changed) {
    $registry.updatedAt = Get-Date -Format "yyyy-MM-dd"
    # 统一写 UTF-8 无 BOM，避免不同 PowerShell 版本的默认编码差异
    [System.IO.File]::WriteAllText($registryPath, ($registry | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Write-Host "registry.json 已更新，请提交推送"
}
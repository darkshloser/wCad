#!/usr/bin/env pwsh
# wCAD — CAD/GIS Web Application
# Copyright (C) 2026 Dobromir
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# PowerShell task runner — the Windows equivalent of the Makefile.
#
# GNU Make is not installed on Windows by default, so every Makefile target is mirrored here.
# The two files must stay in step; if you add a target to one, add it to the other.
#
#   .\wcad.ps1 help
#   .\wcad.ps1 up
#   .\wcad.ps1 seed -File fixtures\blocks.dxf
#   .\wcad.ps1 verify
#
# If PowerShell refuses to run this, unblock it for the current session only:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Task = 'help',

    [string]$File = 'fixtures/small.dxf',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$Compose = @('docker', 'compose')
$Tools = @('docker', 'compose', '--profile', 'tools')

function Get-Port([string]$name, [int]$fallback) {
    if (Test-Path '.env') {
        $line = Select-String -Path '.env' -Pattern "^$name=(\d+)" -ErrorAction SilentlyContinue |
        Select-Object -First 1
        if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return $fallback
}

$TilesUrl = "http://localhost:$(Get-Port 'TILES_PORT' 3001)"
$WebUrl = "http://localhost:$(Get-Port 'WEB_PORT' 5173)"
$ApiUrl = "http://localhost:$(Get-Port 'API_PORT' 3000)"

function Invoke-Checked([string[]]$Command) {
    Write-Host "> $($Command -join ' ')" -ForegroundColor DarkGray
    & $Command[0] @($Command[1..($Command.Length - 1)])
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $($Command -join ' ')"
    }
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker is not on PATH. Start Docker Desktop and reopen PowerShell.'
    }
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) {
        throw 'Docker is installed but not running. Start Docker Desktop and wait for it to report "Engine running".'
    }
}

function Assert-Env {
    if (-not (Test-Path '.env')) {
        Write-Host 'No .env found — creating one from .env.example' -ForegroundColor Yellow
        Copy-Item '.env.example' '.env'
    }
}

function Get-Json([string]$Url) {
    try {
        Invoke-RestMethod -Uri $Url -TimeoutSec 10
    }
    catch {
        throw "Cannot reach $Url. Is the stack up? Run: .\wcad.ps1 up"
    }
}

function Wait-ForTiles([int]$TimeoutSeconds = 120) {
    Write-Host "Waiting for the tile service at $TilesUrl ..." -NoNewline
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $null = Invoke-RestMethod -Uri "$TilesUrl/health" -TimeoutSec 3
            Write-Host ' ready' -ForegroundColor Green
            return
        }
        catch {
            Start-Sleep -Seconds 2
            Write-Host '.' -NoNewline
        }
    }
    Write-Host ''
    throw "Tile service did not become healthy within ${TimeoutSeconds}s. Check: .\wcad.ps1 logs"
}

# ------------------------------------------------------------------ tasks

$Tasks = [ordered]@{
    'help'             = 'Show this list'
    'up'               = 'Start the full stack'
    'down'             = 'Stop everything'
    'ps'               = 'Show service status'
    'logs'             = 'Tail logs from all services'
    'test'             = 'Unit, property and contract tests'
    'test-integration' = 'Testcontainers suites against real PostGIS'
    'test-workers'     = 'Python worker suites against real PostGIS'
    'e2e'              = 'Playwright render-budget tests'
    'typecheck'        = 'Project-wide TypeScript check'
    'depcruise'        = 'Architectural boundary enforcement (guardrail G1)'
    'fixtures'         = 'Generate the standard fixture set'
    'fixture-large'    = 'Generate the 10M-entity fixture (~1.4 GB)'
    'seed'             = 'Bulk-load a fixture for benchmarking (-File fixtures\blocks.dxf)'
    'import'           = 'Import a DXF through the real pipeline (-File fixtures\small.dxf)'
    'migrate'          = 'Apply pending schema migrations'
    'migrate-status'   = 'Show which migrations are applied'
    'flush-tiles'      = 'Clear both tile cache tiers (needed before a meaningful bench)'
    'import-bench'     = 'Phase 3 exit gate: import 10M entities against the budgets'
    'bench'            = 'Benchmark the tile service against the Phase 2 budgets'
    'verify'           = 'Phase 2 exit gate: unit + integration + health + budgets'
    'projects'         = 'List projects known to the tile service'
    'tile-metrics'     = 'Show tile cache counters'
    'psql'             = 'psql into the database'
    'valkey'           = 'valkey-cli against the cache'
    'shell'            = 'Shell into the tooling container'
    'clean'            = 'Stop and remove volumes (destroys local data)'
}

switch ($Task.ToLowerInvariant()) {

    'help' {
        Write-Host ''
        Write-Host '  wCAD task runner' -ForegroundColor Cyan
        Write-Host ''
        foreach ($t in $Tasks.GetEnumerator()) {
            Write-Host ('    {0,-18} {1}' -f $t.Key, $t.Value)
        }
        Write-Host ''
        Write-Host '  First run:' -ForegroundColor Cyan
        Write-Host '    .\wcad.ps1 up'
        Write-Host '    .\wcad.ps1 fixtures'
        Write-Host '    .\wcad.ps1 seed -File fixtures\blocks.dxf'
        Write-Host '    .\wcad.ps1 verify'
        Write-Host ''
    }

    'up' {
        Assert-Docker
        Assert-Env
        # One-time, single-container lockfile bootstrap. Every service below bind-mounts this
        # same host directory, including pnpm-lock.yaml — if each service's own entrypoint tried
        # to generate that file itself, containers starting together would race to write it
        # concurrently. Running it once here, sequentially, before anything else starts, means
        # every service's entrypoint can safely treat the lockfile as read-only afterward.
        # Cheap and safe to repeat: if the lockfile already matches, this is a fast no-op.
        Write-Host 'Resolving dependencies (one-time lockfile bootstrap)...' -ForegroundColor Cyan
        Invoke-Checked ($Tools + @('run', '-e', 'WCAD_BOOTSTRAP=1', '--build', '--rm', 'test',
                'pnpm', 'install', '--no-frozen-lockfile'))
        Invoke-Checked ($Compose + @('up', '-d', '--build'))

        # init.sql only ever runs on an empty data directory, so schema changes reach an existing
        # database through migrations or not at all. Idempotent, so running it every time is safe.
        Write-Host 'Applying schema migrations...' -ForegroundColor Cyan
        Invoke-Checked ($Compose + @('run', '--rm', 'workers', 'python', '-m', 'wcad_workers.migrate'))

        Write-Host ''
        Write-Host "  web     $WebUrl" -ForegroundColor Green
        Write-Host "  tiles   $TilesUrl/health" -ForegroundColor Green
        Write-Host "  api     $ApiUrl/health" -ForegroundColor Green
        Write-Host ''
        Write-Host '  next:   .\wcad.ps1 seed        (load a fixture)'
        Write-Host '          .\wcad.ps1 verify      (run the Phase 2 exit gate)'
    }

    'down' { Assert-Docker; Invoke-Checked ($Compose + @('down')) }
    'ps' { Assert-Docker; Invoke-Checked ($Compose + @('ps')) }
    'logs' { Assert-Docker; Invoke-Checked ($Compose + @('logs', '-f')) }

    'test' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'test'))
    }

    'test-integration' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'vitest', 'run', '--config', 'vitest.integration.config.ts'))
    }

    'test-workers' {
        Assert-Docker; Assert-Env
        # Runs against the compose PostGIS: the queue's guarantees are database guarantees, so
        # these suites skip themselves rather than mock when DATABASE_URL is absent.
        Invoke-Checked ($Compose + @('run', '--build', '--rm', 'workers', 'pytest', '-q'))
    }

    'e2e' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'e2e'))
    }

    'typecheck' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'typecheck'))
    }

    'depcruise' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'depcruise'))
    }

    'fixtures' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'fixtures:generate'))
    }

    'fixture-large' {
        Assert-Docker; Assert-Env
        Write-Host 'Generating 10M entities (~1.4 GB). This takes a few minutes.' -ForegroundColor Yellow
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'fixtures:generate', '--entities', '10000000', '--out', 'large.dxf'))
    }

    'seed' {
        Assert-Docker; Assert-Env
        # Container paths are POSIX even when the argument was typed with backslashes.
        $target = $File -replace '\\', '/'
        if (-not (Test-Path $target)) {
            throw "$target does not exist. Generate fixtures first: .\wcad.ps1 fixtures"
        }
        Wait-ForTiles
        # `run` on the tooling container, not `exec` on the tile service: exec skips the image
        # ENTRYPOINT, so it depends on the long-running container having relinked correctly at
        # start. `run` always goes through the entrypoint, so workspace links are guaranteed.
        Invoke-Checked ($Tools + @('run', '--rm', '-e', 'TILES_URL=http://tiles:3001', 'test',
                'node', '--experimental-strip-types', 'tools/seed/loadFixture.ts', '--file', $target))
    }

    'migrate' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Compose + @('run', '--rm', 'workers', 'python', '-m', 'wcad_workers.migrate'))
    }

    'migrate-status' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Compose + @('run', '--rm', 'workers',
                'python', '-m', 'wcad_workers.migrate', 'status'))
    }

    'flush-tiles' {
        Assert-Docker
        # Both tiers, or the cold tier silently repopulates the hot one with the same stale bytes.
        Write-Host 'Flushing hot tier (Valkey)...' -ForegroundColor Cyan
        Invoke-Checked ($Compose + @('exec', 'valkey', 'valkey-cli', 'FLUSHALL'))
        Write-Host 'Flushing cold tier (filesystem)...' -ForegroundColor Cyan
        Invoke-Checked ($Compose + @('exec', 'tiles', 'sh', '-c',
                'rm -rf /var/lib/wcad/objects/tiles/* 2>/dev/null; echo cleared'))
        Write-Host 'Tile cache cleared. The next request for each tile regenerates it.' -ForegroundColor Green
    }

    'import' {
        Assert-Docker; Assert-Env
        # Fixtures are mounted at /fixtures in the workers container.
        $target = $File -replace '\\', '/'
        if (-not (Test-Path $target)) {
            throw "$target does not exist. Generate fixtures first: .\wcad.ps1 fixtures"
        }
        $inContainer = $target -replace '^fixtures/', '/fixtures/'
        Invoke-Checked ($Compose + @('run', '--build', '--rm', 'workers',
                'python', '-m', 'wcad_workers.main', 'import', '--file', $inContainer))
    }

    'import-bench' {
        Assert-Docker; Assert-Env
        # The Phase 3 exit criterion: 10M entities, under 15 minutes, flat memory, exact
        # reconciliation. Generates the fixture first if it is missing — it is not in git.
        # Present is not the same as usable. Fixtures written before the DXF writer was fixed
        # declare AC1009 (R12) while containing R2000 entities, and a real reader rejects them
        # part-way through — after nine minutes of block loading, in the case that prompted this.
        # Checking the version is cheap; discovering it mid-import is not.
        $needsFixture = $true
        if (Test-Path 'fixtures/large.dxf') {
            $head = Get-Content 'fixtures/large.dxf' -TotalCount 40 -ErrorAction SilentlyContinue
            if ($head -contains 'AC1015') {
                $needsFixture = $false
            }
            else {
                Write-Host 'large.dxf predates the DXF writer fix and is not valid DXF; regenerating.' -ForegroundColor Yellow
            }
        }
        if ($needsFixture) {
            Write-Host 'Generating 10M entities (~1.4 GB, several minutes)...' -ForegroundColor Yellow
            Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test',
                    'pnpm', 'fixtures:generate', '--entities', '10000000', '--out', 'large.dxf'))
        }
        Write-Host 'Importing 10M entities through the real pipeline. This takes a while.' -ForegroundColor Cyan
        Invoke-Checked ($Compose + @('run', '--build', '--rm', 'workers',
                'python', '-m', 'wcad_workers.main', 'import',
                '--file', '/fixtures/large.dxf', '--name', 'large-import-bench', '--budgets'))
    }

    'bench' {
        Assert-Docker
        Wait-ForTiles
        Invoke-Checked ($Tools + @('run', '--rm', '-e', 'TILES_URL=http://tiles:3001', 'test',
                'node', '--experimental-strip-types', 'tools/bench/tileBench.ts', '--url', 'http://tiles:3001'))
    }

    'verify' {
        Assert-Docker; Assert-Env
        Write-Host '== 1/4 unit, property and contract tests ==' -ForegroundColor Cyan
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'pnpm', 'test'))

        Write-Host ''
        Write-Host '== 2/4 integration tests against real PostGIS ==' -ForegroundColor Cyan
        Invoke-Checked ($Tools + @('run', '--rm', 'test', 'pnpm', 'vitest', 'run', '--config', 'vitest.integration.config.ts'))

        Write-Host ''
        Write-Host '== 3/4 tile service reachable ==' -ForegroundColor Cyan
        Wait-ForTiles
        Get-Json "$TilesUrl/health" | ConvertTo-Json -Compress | Write-Host

        Write-Host ''
        Write-Host '== 4/4 performance budgets ==' -ForegroundColor Cyan
        # Flush first: a cached tile is served exactly as it was built, so without this the gate
        # measures whatever the last run left behind and reports zero cache misses as a pass.
        Write-Host 'Clearing the tile cache so generation is actually measured...' -ForegroundColor DarkGray
        Invoke-Checked ($Compose + @('exec', 'valkey', 'valkey-cli', 'FLUSHALL'))
        Invoke-Checked ($Compose + @('exec', 'tiles', 'sh', '-c',
                'rm -rf /var/lib/wcad/objects/tiles/* 2>/dev/null; echo cleared'))
        Invoke-Checked ($Tools + @('run', '--rm', '-e', 'TILES_URL=http://tiles:3001', 'test',
                'node', '--experimental-strip-types', 'tools/bench/tileBench.ts', '--url', 'http://tiles:3001'))
    }

    'projects' {
        $result = Get-Json "$TilesUrl/projects"
        if ($result.projects.Count -eq 0) {
            Write-Host 'No projects loaded. Run: .\wcad.ps1 seed -File fixtures\blocks.dxf' -ForegroundColor Yellow
        }
        else {
            $result.projects | Format-Table id, name, crs, elementCount -AutoSize
            Write-Host "Open: $WebUrl/?project=$($result.projects[0].id)" -ForegroundColor Green
        }
    }

    'tile-metrics' {
        Get-Json "$TilesUrl/metrics" | Format-List
    }

    'psql' {
        Assert-Docker
        $user = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'wcad' }
        $db = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { 'wcad' }
        Invoke-Checked ($Compose + @('exec', 'postgis', 'psql', '-U', $user, '-d', $db))
    }

    'valkey' {
        Assert-Docker
        Invoke-Checked ($Compose + @('exec', 'valkey', 'valkey-cli'))
    }

    'shell' {
        Assert-Docker; Assert-Env
        Invoke-Checked ($Tools + @('run', '--build', '--rm', 'test', 'bash'))
    }

    'clean' {
        Assert-Docker
        Write-Host 'This destroys the database, cache and object store volumes.' -ForegroundColor Yellow
        $answer = Read-Host 'Type "yes" to continue'
        if ($answer -eq 'yes') { Invoke-Checked ($Compose + @('down', '-v')) }
        else { Write-Host 'Cancelled.' }
    }

    default {
        Write-Host "Unknown task '$Task'." -ForegroundColor Red
        Write-Host 'Run .\wcad.ps1 help for the list.'
        exit 1
    }
}

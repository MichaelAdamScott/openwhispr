# Launch the source checkout using its built interface and existing test profile.
# Persistent log files keep Electron independent of a terminal's output pipes.
$ErrorActionPreference = 'Stop'

try {
    $appRepository = Split-Path -Parent $PSScriptRoot
    $appExecutable = Join-Path $appRepository 'node_modules\electron\dist\electron.exe'
    $appInterface = Join-Path $appRepository 'src\dist\index.html'

    if (-not (Test-Path -LiteralPath $appExecutable)) {
        throw 'The desktop runtime is missing. Install the project dependencies before starting OpenWhispr.'
    }
    if (-not (Test-Path -LiteralPath $appInterface)) {
        throw 'The app interface is missing. Build the project interface before starting OpenWhispr.'
    }

    $appLogDirectory = Join-Path $appRepository 'logs\launcher'
    New-Item -ItemType Directory -Path $appLogDirectory -Force | Out-Null
    $appRunId = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)

    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $env:NODE_ENV = 'production'
    # Preserve the settings and model selections used in this custom build.
    $env:OPENWHISPR_CHANNEL = 'development'

    $appStartOptions = @{
        FilePath = $appExecutable
        ArgumentList = @('"' + $appRepository + '"')
        WorkingDirectory = $appRepository
        WindowStyle = 'Normal'
        RedirectStandardOutput = Join-Path $appLogDirectory ($appRunId + '.stdout.log')
        RedirectStandardError = Join-Path $appLogDirectory ($appRunId + '.stderr.log')
        PassThru = $true
    }
    $appInstance = Start-Process @appStartOptions
    $appInstance.Id | Set-Content -LiteralPath (Join-Path $appLogDirectory 'last-process.pid')
}
catch {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        $_.Exception.Message,
        'OpenWhispr Custom could not start',
        [System.Windows.MessageBoxButton]::OK,
        [System.Windows.MessageBoxImage]::Error
    ) | Out-Null
    exit 1
}

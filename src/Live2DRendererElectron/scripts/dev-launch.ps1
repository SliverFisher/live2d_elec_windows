# Temporary launcher for dev-mode testing without the WPF host.
# Creates named pipes, launches Electron with --command-pipe/--event-pipe,
# then sends a LoadModel command and tails the event stream for ~3 minutes.
# Safe to delete after testing.

$ErrorActionPreference = 'Stop'

$cmdPipeName = "live2d-cmd-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$evtPipeName = "live2d-evt-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$electronExe = "C:\Users\49213\Desktop\A\codex\Live\src\Live2DRendererElectron\node_modules\electron\dist\electron.exe"
$appDir = "C:\Users\49213\Desktop\A\codex\Live\src\Live2DRendererElectron"
# Find the first .model3.json under the assets/live2d folder to avoid hardcoding non-ASCII paths.
$live2dRoot = "C:\Users\49213\Desktop\A\codex\Live\assests\live2d"
$modelFile = Get-ChildItem -LiteralPath $live2dRoot -Recurse -Filter "*.model3.json" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $modelFile) {
    Write-Host "ERROR: no .model3.json found under $live2dRoot"
    exit 1
}
# Use the raw bytes of the path so nothing is re-encoded.
$modelPath = ($modelFile.FullName -replace '\\', '/')

Write-Host "Creating named pipes: cmd=$cmdPipeName evt=$evtPipeName"

$cmdPipe = New-Object System.IO.Pipes.NamedPipeServerStream($cmdPipeName, [System.IO.Pipes.PipeDirection]::Out, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte)
$evtPipe = New-Object System.IO.Pipes.NamedPipeServerStream($evtPipeName, [System.IO.Pipes.PipeDirection]::In, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte)

Write-Host "Launching Electron..."
$proc = Start-Process -FilePath $electronExe `
    -ArgumentList ".", "--command-pipe=$cmdPipeName", "--event-pipe=$evtPipeName" `
    -WorkingDirectory $appDir `
    -PassThru -NoNewWindow

Write-Host "Electron PID: $($proc.Id). Waiting for pipe connections..."

# Wait for Electron to connect to both pipes (async to avoid deadlock)
$cmdTask = $cmdPipe.WaitForConnectionAsync()
$evtTask = $evtPipe.WaitForConnectionAsync()
[void][System.Threading.Tasks.Task]::WaitAll(@($cmdTask, $evtTask), 30000)

if (-not $cmdPipe.IsConnected -or -not $evtPipe.IsConnected) {
    Write-Host "ERROR: pipes did not connect within 30s"
    $cmdPipe.Dispose(); $evtPipe.Dispose()
    exit 1
}

Write-Host "Pipes connected. Waiting for RendererReady before sending LoadModel..."

$reader = New-Object System.IO.StreamReader($evtPipe, [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter($cmdPipe, [System.Text.Encoding]::UTF8)
$writer.NewLine = "`n"

$readySeen = $false
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
    $line = $reader.ReadLine()
    if ($null -eq $line) {
        Start-Sleep -Milliseconds 50
        continue
    }
    Write-Host "EVENT: $line"
    if (-not $readySeen -and $line -match '"type":"RendererReady"') {
        $readySeen = $true
        Write-Host "RendererReady received. Sending LoadModel for: $modelPath"
        Start-Sleep -Milliseconds 200
        $cmd = @{ type = 'LoadModel'; modelPath = $modelPath } | ConvertTo-Json -Compress
        $writer.WriteLine($cmd)
        $writer.Flush()
        Write-Host "LoadModel sent."
    }
}

Write-Host "Done tailing events. Leaving Electron running. Press Ctrl+C to stop."
$proc.WaitForExit()

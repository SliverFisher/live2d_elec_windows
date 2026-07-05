using System.Diagnostics;

var logPath = Path.Combine(AppContext.BaseDirectory, "wrapper-start.txt");
File.WriteAllText(logPath, string.Join(Environment.NewLine,
    $"Time: {DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}",
    $"PID: {Process.GetCurrentProcess().Id}",
    $"CWD: {Environment.CurrentDirectory}",
    $"Args: [{string.Join(", ", args)}]",
    $"BaseDir: {AppContext.BaseDirectory}"
));

var baseDirectory = AppContext.BaseDirectory;
var hostPath = Path.Combine(baseDirectory, "Live2DRendererHost.exe");

File.AppendAllText(logPath, $"{Environment.NewLine}Step 1: hostPath={hostPath}");
File.AppendAllText(logPath, $"{Environment.NewLine}Step 2: hostExists={File.Exists(hostPath)}");

if (!File.Exists(hostPath))
{
    File.AppendAllText(logPath, $"{Environment.NewLine}Step ERROR: host not found");
    return 2;
}

File.AppendAllText(logPath, $"{Environment.NewLine}Step 3: parsing args");

var pipeName = GetArgValue(args, "--pipe-name");
var parentPid = GetArgValue(args, "--parent-pid");
var logDir = GetArgValue(args, "--log-dir");
var explicitModel = GetArgValue(args, "--model");
var noDefaultModel = args.Any(arg => string.Equals(arg, "--no-default-model", StringComparison.OrdinalIgnoreCase));

File.AppendAllText(logPath, $"{Environment.NewLine}Step 4: pipeName={pipeName}, parentPid={parentPid}, logDir={logDir}");

var isAiMaidMode = !string.IsNullOrWhiteSpace(pipeName);

File.AppendAllText(logPath, $"{Environment.NewLine}Step 5: isAiMaidMode={isAiMaidMode}");

string? startupModelPath = null;
if (!isAiMaidMode && !noDefaultModel)
{
    startupModelPath = ResolveStartupModelPath(explicitModel, baseDirectory);
}

File.AppendAllText(logPath, $"{Environment.NewLine}Step 6: startupModelPath={startupModelPath}");

File.AppendAllText(logPath, $"{Environment.NewLine}Step 7: creating Process");

using var host = new Process();
host.StartInfo.FileName = hostPath;
host.StartInfo.WorkingDirectory = baseDirectory;
host.StartInfo.UseShellExecute = false;
host.StartInfo.CreateNoWindow = true;
host.StartInfo.RedirectStandardError = true;
host.StartInfo.RedirectStandardOutput = true;
host.StartInfo.RedirectStandardInput = true;

File.AppendAllText(logPath, $"{Environment.NewLine}Step 8: setting arguments");

if (!string.IsNullOrWhiteSpace(pipeName))
{
    host.StartInfo.ArgumentList.Add("--pipe-name");
    host.StartInfo.ArgumentList.Add(pipeName);
}

if (!string.IsNullOrWhiteSpace(parentPid))
{
    host.StartInfo.ArgumentList.Add("--parent-pid");
    host.StartInfo.ArgumentList.Add(parentPid);
}

if (!string.IsNullOrWhiteSpace(logDir))
{
    host.StartInfo.ArgumentList.Add("--log-dir");
    host.StartInfo.ArgumentList.Add(logDir);
}

if (!isAiMaidMode && !string.IsNullOrWhiteSpace(startupModelPath))
{
    host.StartInfo.ArgumentList.Add("--model");
    host.StartInfo.ArgumentList.Add(startupModelPath);
}

if (noDefaultModel)
{
    host.StartInfo.ArgumentList.Add("--no-default-model");
}

File.AppendAllText(logPath, $"{Environment.NewLine}Step 9: starting host process");

host.Start();

File.AppendAllText(logPath, $"{Environment.NewLine}Step 10: host started, PID={host.Id}");

var stdinTask = Task.Run(async () =>
{
    try
    {
        var stdin = Console.OpenStandardInput();
        var hostStdin = host.StandardInput.BaseStream;
        await stdin.CopyToAsync(hostStdin);
    }
    catch { }
    try { host.StandardInput.Close(); } catch { }
});

var stdoutTask = Task.Run(async () =>
{
    try
    {
        var stdout = Console.OpenStandardOutput();
        var hostStdout = host.StandardOutput.BaseStream;
        await hostStdout.CopyToAsync(stdout);
    }
    catch { }
});

var stderrTask = Task.Run(async () =>
{
    try
    {
        var stderr = Console.OpenStandardError();
        using var writer = new System.IO.StreamWriter(stderr) { AutoFlush = true };
        string? line;
        while ((line = await host.StandardError.ReadLineAsync()) is not null)
        {
            await writer.WriteLineAsync(line);
        }
    }
    catch { }
});

File.AppendAllText(logPath, $"{Environment.NewLine}Step 11: waiting for host exit");

await host.WaitForExitAsync();
await Task.WhenAny(Task.WhenAll(stdinTask, stdoutTask, stderrTask), Task.Delay(500));

File.AppendAllText(logPath, $"{Environment.NewLine}Step 12: host exited, exitCode={host.ExitCode}");

return host.ExitCode;

static string? ResolveStartupModelPath(string? explicitModel, string baseDirectory)
{
    if (!string.IsNullOrWhiteSpace(explicitModel))
    {
        return Path.GetFullPath(explicitModel);
    }

    var defaultModel = Path.GetFullPath(Path.Combine(
        baseDirectory,
        "..",
        "..",
        "..",
        "assests",
        "live2d",
        "符玄",
        "符玄.model3.json"));

    return File.Exists(defaultModel) ? defaultModel : null;
}

static string? GetArgValue(string[] args, string name)
{
    var prefix = $"{name}=";
    for (var index = 0; index < args.Length; index++)
    {
        var arg = args[index];
        if (string.Equals(arg, name, StringComparison.OrdinalIgnoreCase))
        {
            return index + 1 < args.Length ? args[index + 1] : null;
        }

        if (arg.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return arg[prefix.Length..];
        }
    }

    return null;
}
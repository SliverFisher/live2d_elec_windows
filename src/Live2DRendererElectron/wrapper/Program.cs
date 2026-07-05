using System.Diagnostics;
using System.Text;

Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });

// Live2DRenderer.exe is a thin .NET wrapper that launches the Electron host
// (Live2DRendererHost.exe) and transparently forwards the AI_maid Named Pipe
// protocol arguments. The wrapper does NOT create its own pipes — all
// protocol traffic flows directly between AI_maid and the Electron host.
//
// Supported arguments (forwarded to the host):
//   --pipe-name <name>       Named Pipe to connect (AI_maid mode)
//   --parent-pid <pid>       Parent process PID to watch for exit
//   --log-dir <dir>          Log output directory
//   --model <path>           Dev/debug model path
//   --no-default-model       Skip loading any default model
//
// When --pipe-name is NOT provided, the wrapper enters debug mode and will
// auto-load a default model (unless --no-default-model is given), so running
// the exe standalone still shows the character.

var baseDirectory = AppContext.BaseDirectory;
var hostPath = Path.Combine(baseDirectory, "Live2DRendererHost.exe");

if (!File.Exists(hostPath))
{
    Console.Error.WriteLine($"Live2DRendererHost.exe was not found: {hostPath}");
    return 2;
}

// Parse arguments
var pipeName = GetArgValue(args, "--pipe-name");
var parentPid = GetArgValue(args, "--parent-pid");
var logDir = GetArgValue(args, "--log-dir");
var explicitModel = GetArgValue(args, "--model");
var noDefaultModel = args.Any(arg => string.Equals(arg, "--no-default-model", StringComparison.OrdinalIgnoreCase));

var isAiMaidMode = !string.IsNullOrWhiteSpace(pipeName);

// Resolve startup model path (only used in debug mode, or as a fallback hint)
// In AI_maid mode, model loading is driven by the LoadModel command, so we
// do NOT auto-inject a model path.
string? startupModelPath = null;
if (!isAiMaidMode && !noDefaultModel)
{
    startupModelPath = ResolveStartupModelPath(explicitModel, baseDirectory);
}

using var host = new Process();
host.StartInfo.FileName = hostPath;
host.StartInfo.WorkingDirectory = baseDirectory;
host.StartInfo.UseShellExecute = false;
host.StartInfo.CreateNoWindow = true;
host.StartInfo.RedirectStandardError = true;
host.StartInfo.RedirectStandardOutput = true;
host.StartInfo.RedirectStandardInput = true;

// Forward protocol arguments to the Electron host
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

// In debug mode (no --pipe-name), pass --model so the host auto-loads it
if (!isAiMaidMode && !string.IsNullOrWhiteSpace(startupModelPath))
{
    host.StartInfo.ArgumentList.Add("--model");
    host.StartInfo.ArgumentList.Add(startupModelPath);
}

if (noDefaultModel)
{
    host.StartInfo.ArgumentList.Add("--no-default-model");
}

host.Start();

// Pipe stdin/stdout/stderr through transparently.
// The wrapper does NOT interpret the JSON Lines protocol — bytes flow as-is.
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
    string? line;
    while ((line = await host.StandardError.ReadLineAsync()) is not null)
    {
        Console.Error.WriteLine(line);
    }
});

await host.WaitForExitAsync();

// Give pipes a moment to flush
await Task.WhenAny(Task.WhenAll(stdoutTask, stderrTask), Task.Delay(500));

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

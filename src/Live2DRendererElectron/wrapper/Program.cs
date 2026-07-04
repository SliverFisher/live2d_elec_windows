using System.Diagnostics;
using System.IO.Pipes;
using System.Text;

Console.InputEncoding = new UTF8Encoding(false);
Console.OutputEncoding = new UTF8Encoding(false);
Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });

var baseDirectory = AppContext.BaseDirectory;
var hostPath = Path.Combine(baseDirectory, "Live2DRendererHost.exe");
var startupModelPath = ResolveStartupModelPath(args, baseDirectory);

if (!File.Exists(hostPath))
{
    Console.Error.WriteLine($"Live2DRendererHost.exe was not found: {hostPath}");
    return 2;
}

var id = Guid.NewGuid().ToString("N");
var commandPipeName = $"Live2DRenderer-{id}-commands";
var eventPipeName = $"Live2DRenderer-{id}-events";

await using var commandPipe = new NamedPipeServerStream(
    commandPipeName,
    PipeDirection.Out,
    1,
    PipeTransmissionMode.Byte,
    PipeOptions.Asynchronous);

await using var eventPipe = new NamedPipeServerStream(
    eventPipeName,
    PipeDirection.In,
    1,
    PipeTransmissionMode.Byte,
    PipeOptions.Asynchronous);

using var host = new Process();
host.StartInfo.FileName = hostPath;
host.StartInfo.WorkingDirectory = baseDirectory;
host.StartInfo.UseShellExecute = false;
host.StartInfo.CreateNoWindow = true;
host.StartInfo.RedirectStandardError = true;
host.StartInfo.ArgumentList.Add("--command-pipe");
host.StartInfo.ArgumentList.Add(commandPipeName);
host.StartInfo.ArgumentList.Add("--event-pipe");
host.StartInfo.ArgumentList.Add(eventPipeName);

host.Start();

var commandConnectTask = commandPipe.WaitForConnectionAsync();
var eventConnectTask = eventPipe.WaitForConnectionAsync();
var hostExitTask = host.WaitForExitAsync();
var connectTask = Task.WhenAll(commandConnectTask, eventConnectTask);

if (await Task.WhenAny(connectTask, hostExitTask) != connectTask)
{
    Console.Error.WriteLine(await host.StandardError.ReadToEndAsync());
    return host.ExitCode == 0 ? 1 : host.ExitCode;
}

await connectTask;

using var commandWriter = new StreamWriter(commandPipe, new UTF8Encoding(false), leaveOpen: true)
{
    AutoFlush = true,
    NewLine = "\n"
};
using var eventReader = new StreamReader(eventPipe, Encoding.UTF8, leaveOpen: true);
var closedEvent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

var stdinTask = Task.Run(async () =>
{
    string? line;
    while ((line = await Console.In.ReadLineAsync()) is not null)
    {
        await commandWriter.WriteLineAsync(line);
    }
});

var stdoutTask = Task.Run(async () =>
{
    string? line;
    var startupModelSent = false;
    while ((line = await eventReader.ReadLineAsync()) is not null)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
        if (!startupModelSent &&
            startupModelPath is not null &&
            line.Contains("\"type\":\"RendererReady\"", StringComparison.Ordinal))
        {
            startupModelSent = true;
            var command = $"{{\"type\":\"LoadModel\",\"modelPath\":\"{EscapeJsonString(startupModelPath.Replace('\\', '/'))}\"}}";
            await commandWriter.WriteLineAsync(command);
        }

        if (line.Contains("\"type\":\"Closed\"", StringComparison.Ordinal))
        {
            closedEvent.TrySetResult();
            break;
        }
    }
});

var stderrTask = Task.Run(async () =>
{
    string? line;
    while ((line = await host.StandardError.ReadLineAsync()) is not null)
    {
        Console.Error.WriteLine(line);
    }
});

await Task.WhenAny(hostExitTask, stdoutTask, stdinTask, closedEvent.Task);
var closedNormally = closedEvent.Task.IsCompletedSuccessfully;

if (!host.HasExited)
{
    try
    {
        if (!closedNormally)
        {
            await commandWriter.WriteLineAsync("{\"type\":\"Close\"}");
        }

        if (!host.WaitForExit(3000))
        {
            host.Kill(entireProcessTree: true);
        }
    }
    catch
    {
        if (!host.HasExited)
        {
            host.Kill(entireProcessTree: true);
        }
    }
}

await Task.WhenAny(stderrTask, Task.Delay(1000));
return closedNormally ? 0 : host.ExitCode;

static string? ResolveStartupModelPath(string[] args, string baseDirectory)
{
    if (args.Any(arg => string.Equals(arg, "--no-default-model", StringComparison.OrdinalIgnoreCase)))
    {
        return null;
    }

    var explicitModel = GetArgValue(args, "--model") ?? Environment.GetEnvironmentVariable("LIVE2D_RENDERER_MODEL");
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

static string EscapeJsonString(string value)
{
    var builder = new StringBuilder(value.Length + 16);
    foreach (var character in value)
    {
        switch (character)
        {
            case '\\':
                builder.Append(@"\\");
                break;
            case '"':
                builder.Append("\\\"");
                break;
            case '\b':
                builder.Append(@"\b");
                break;
            case '\f':
                builder.Append(@"\f");
                break;
            case '\n':
                builder.Append(@"\n");
                break;
            case '\r':
                builder.Append(@"\r");
                break;
            case '\t':
                builder.Append(@"\t");
                break;
            default:
                builder.Append(character);
                break;
        }
    }

    return builder.ToString();
}

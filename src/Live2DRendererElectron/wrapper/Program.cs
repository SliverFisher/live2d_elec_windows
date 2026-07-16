using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

NativeWindowBounds.EnablePerMonitorV2();

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
var virtualScreenLeft = GetArgValue(args, "--virtual-screen-left");
var virtualScreenTop = GetArgValue(args, "--virtual-screen-top");
var virtualScreenWidth = GetArgValue(args, "--virtual-screen-width");
var virtualScreenHeight = GetArgValue(args, "--virtual-screen-height");
var systemDpiScale = GetArgValue(args, "--system-dpi-scale");

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

ForwardValueArg(host.StartInfo.ArgumentList, "--virtual-screen-left", virtualScreenLeft);
ForwardValueArg(host.StartInfo.ArgumentList, "--virtual-screen-top", virtualScreenTop);
ForwardValueArg(host.StartInfo.ArgumentList, "--virtual-screen-width", virtualScreenWidth);
ForwardValueArg(host.StartInfo.ArgumentList, "--virtual-screen-height", virtualScreenHeight);
ForwardValueArg(host.StartInfo.ArgumentList, "--system-dpi-scale", systemDpiScale);

File.AppendAllText(logPath, $"{Environment.NewLine}Step 9: starting host process");

var rendererLogPath = string.IsNullOrWhiteSpace(logDir)
    ? null
    : Path.Combine(logDir, "live2d-renderer.log");
var rendererLogOffset = rendererLogPath is not null && File.Exists(rendererLogPath)
    ? new FileInfo(rendererLogPath).Length
    : 0L;

host.Start();

File.AppendAllText(logPath, $"{Environment.NewLine}Step 10: host started, PID={host.Id}");

// Begin draining redirected pipes immediately. Waiting for BrowserWindow while
// these pipes are unread can fill the OS pipe buffer and block Electron before
// it reaches BrowserWindow creation.
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

if (TryParseVirtualScreenPhysicalBounds(
        virtualScreenLeft,
        virtualScreenTop,
        virtualScreenWidth,
        virtualScreenHeight,
        systemDpiScale,
        out var physicalBounds))
{
    var windowCreated = rendererLogPath is not null &&
        await WaitForLogMarkerAsync(
            rendererLogPath,
            rendererLogOffset,
            "BrowserWindow created",
            TimeSpan.FromSeconds(20));
    var applied = windowCreated &&
        await NativeWindowBounds.TryApplyAsync(host.Id, physicalBounds, TimeSpan.FromSeconds(3), logPath);
    File.AppendAllText(logPath,
        $"{Environment.NewLine}Step 10.1: browserWindowCreated={windowCreated}, " +
        $"native virtual-screen bounds applied={applied}, " +
        $"bounds=({physicalBounds.X},{physicalBounds.Y},{physicalBounds.Width},{physicalBounds.Height})");
}

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

static void ForwardValueArg(ICollection<string> target, string name, string? value)
{
    if (string.IsNullOrWhiteSpace(value)) return;
    target.Add(name);
    target.Add(value);
}

static bool TryParseVirtualScreenPhysicalBounds(
    string? left,
    string? top,
    string? width,
    string? height,
    string? dpiScale,
    out NativeWindowBounds.Bounds bounds)
{
    bounds = default;
    var culture = CultureInfo.InvariantCulture;
    if (!double.TryParse(left, NumberStyles.Float, culture, out var x) ||
        !double.TryParse(top, NumberStyles.Float, culture, out var y) ||
        !double.TryParse(width, NumberStyles.Float, culture, out var w) ||
        !double.TryParse(height, NumberStyles.Float, culture, out var h) ||
        !double.TryParse(dpiScale, NumberStyles.Float, culture, out var scale) ||
        w <= 0 || h <= 0 || scale <= 0)
    {
        return false;
    }

    var physicalLeft = (int)Math.Floor(x * scale);
    var physicalTop = (int)Math.Floor(y * scale);
    var physicalRight = (int)Math.Ceiling((x + w) * scale);
    var physicalBottom = (int)Math.Ceiling((y + h) * scale);
    bounds = new NativeWindowBounds.Bounds(
        physicalLeft,
        physicalTop,
        physicalRight - physicalLeft,
        physicalBottom - physicalTop);
    return true;
}

static async Task<bool> WaitForLogMarkerAsync(
    string path,
    long initialOffset,
    string marker,
    TimeSpan timeout)
{
    var deadline = DateTime.UtcNow + timeout;
    while (DateTime.UtcNow < deadline)
    {
        try
        {
            if (File.Exists(path))
            {
                await using var stream = new FileStream(
                    path,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete);
                if (stream.Length >= initialOffset)
                {
                    stream.Position = initialOffset;
                    using var reader = new StreamReader(stream, Encoding.UTF8, true, leaveOpen: false);
                    var appended = await reader.ReadToEndAsync();
                    if (appended.Contains(marker, StringComparison.Ordinal)) return true;
                }
            }
        }
        catch (IOException)
        {
            // Logger may be rotating or flushing; retry until timeout.
        }

        await Task.Delay(50);
    }

    return false;
}

static class NativeWindowBounds
{
    public readonly record struct Bounds(int X, int Y, int Width, int Height);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder className, int maxCount);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hwnd,
        IntPtr insertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

    public static void EnablePerMonitorV2()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        SetProcessDpiAwarenessContext(new IntPtr(-4));
    }

    public static async Task<bool> TryApplyAsync(
        int processId,
        Bounds bounds,
        TimeSpan timeout,
        string tracePath)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var hwnd = FindMainChromeWindow(processId);
            if (hwnd != IntPtr.Zero)
            {
                const uint swpNoZOrder = 0x0004;
                const uint swpNoActivate = 0x0010;
                var result = SetWindowPos(
                    hwnd,
                    IntPtr.Zero,
                    bounds.X,
                    bounds.Y,
                    bounds.Width,
                    bounds.Height,
                    swpNoZOrder | swpNoActivate);
                await Task.Delay(50);
                var matches = GetWindowRect(hwnd, out var actual) &&
                    actual.Left == bounds.X &&
                    actual.Top == bounds.Y &&
                    actual.Right - actual.Left == bounds.Width &&
                    actual.Bottom - actual.Top == bounds.Height;
                File.AppendAllText(tracePath,
                    $"{Environment.NewLine}Native HWND synchronization: SetWindowPos={result}, " +
                    $"verified={matches}, requested=({bounds.X},{bounds.Y},{bounds.Width},{bounds.Height}), " +
                    $"actual=({actual.Left},{actual.Top},{actual.Right - actual.Left},{actual.Bottom - actual.Top})");
                return result && matches;
            }

            await Task.Delay(25);
        }

        return false;
    }

    private static IntPtr FindMainChromeWindow(int processId)
    {
        var result = IntPtr.Zero;
        long largestArea = 0;
        EnumWindows((hwnd, _) =>
        {
            GetWindowThreadProcessId(hwnd, out var ownerProcessId);
            if (ownerProcessId != (uint)processId) return true;

            var className = new StringBuilder(128);
            GetClassName(hwnd, className, className.Capacity);
            if (!className.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;

            if (!GetWindowRect(hwnd, out var rect)) return true;
            var width = rect.Right - rect.Left;
            var height = rect.Bottom - rect.Top;
            if (width < 100 || height < 100) return true;

            var area = (long)width * height;
            if (area > largestArea)
            {
                largestArea = area;
                result = hwnd;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}

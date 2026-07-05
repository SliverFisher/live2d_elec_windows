/** Parsed startup arguments for the Live2D renderer. */
export type StartupArgs = {
  pipeName: string | null;
  parentPid: number | null;
  logDir: string | null;
  model: string | null;
  noDefaultModel: boolean;
};

/**
 * Parse process.argv for AI_maid integration parameters.
 *
 * Supported flags:
 *   --pipe-name <name>      Named Pipe to connect (required for AI_maid mode)
 *   --parent-pid <pid>      Parent process PID to watch for exit
 *   --log-dir <dir>         Log output directory
 *   --model <path>          Dev/debug model path to load directly
 *   --no-default-model      Skip loading any default model
 */
export function parseStartupArgs(argv: string[] = process.argv): StartupArgs {
  const args: StartupArgs = {
    pipeName: null,
    parentPid: null,
    logDir: null,
    model: null,
    noDefaultModel: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--pipe-name':
        if (next && !next.startsWith('--')) {
          args.pipeName = next;
          i++;
        }
        break;
      case '--parent-pid':
        if (next && !next.startsWith('--')) {
          const pid = parseInt(next, 10);
          if (!Number.isNaN(pid) && pid > 0) {
            args.parentPid = pid;
          }
          i++;
        }
        break;
      case '--log-dir':
        if (next && !next.startsWith('--')) {
          args.logDir = next;
          i++;
        }
        break;
      case '--model':
        if (next && !next.startsWith('--')) {
          args.model = next;
          i++;
        }
        break;
      case '--no-default-model':
        args.noDefaultModel = true;
        break;
    }
  }

  return args;
}

/** Returns true when running in AI_maid integration mode (pipe-name provided). */
export function isAiMaidMode(args: StartupArgs): boolean {
  return args.pipeName !== null;
}

/**
 * Shared types for the Live2D renderer modules.
 */

export type MotionCapableModel = {
  motion: (group: string, index?: number) => Promise<unknown>;
  expression: (name: string | number) => void;
  /** Framework-provided audio-driven lip sync. */
  speak?: (
    audioPath: string,
    options?: {
      volume?: number;
      expression?: number | string;
      resetExpression?: boolean;
      crossOrigin?: string | null;
      onFinish?: () => void;
      onError?: (err: unknown) => void;
    }
  ) => void;
  /** Stop any ongoing speak/lip sync started by speak(). */
  stopSpeaking?: () => void;
  internalModel?: {
    coreModel?: {
      setParameterValueById?: (id: string, value: number) => void;
    };
    [key: string]: unknown;
  };
};

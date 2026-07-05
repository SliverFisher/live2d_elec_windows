/**
 * Shared types for the Live2D renderer modules.
 */

export type MotionCapableModel = {
  motion: (group: string, index?: number) => Promise<unknown>;
  expression: (name: string | number) => void;
  internalModel?: {
    coreModel?: {
      setParameterValueById?: (id: string, value: number) => void;
    };
    [key: string]: unknown;
  };
};

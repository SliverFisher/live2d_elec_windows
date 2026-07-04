type MotionCapableModel = {
  motion: (group: string, index?: number) => Promise<unknown>;
  expression: (name: string) => void;
};

export async function playMotion(model: MotionCapableModel | null, group: string, index?: number): Promise<void> {
  if (!model) {
    throw new Error('No Live2D model is loaded.');
  }

  await model.motion(group, index);
}

export function setExpression(model: MotionCapableModel | null, name: string): void {
  if (!model) {
    throw new Error('No Live2D model is loaded.');
  }

  model.expression(name);
}

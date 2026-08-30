export function captureCallerStack(): string {
  const error = new Error();
  return trimCallerStack(error.stack ?? '');
}

export function trimCallerStack(stack: string): string {
  const stackLines = stack.split('\n');
  if (stackLines.length <= 4) {
    return stack;
  }

  return stackLines.slice(0, 4).join('\n');
}

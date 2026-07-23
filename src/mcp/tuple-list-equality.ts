export function tupleListsEqual<Tuple extends readonly unknown[]>(
  left: ReadonlyArray<Tuple>,
  right: ReadonlyArray<Tuple>,
  entryEqual: (leftEntry: Tuple, rightEntry: Tuple) => boolean,
): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index++) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (leftEntry === undefined || rightEntry === undefined) return false;
    if (!entryEqual(leftEntry, rightEntry)) return false;
  }

  return true;
}

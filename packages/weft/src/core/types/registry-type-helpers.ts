export type UnknownNameWhenRegistryHasNoKnownNames<
  TName extends string,
  TKnownNames extends string,
> = [TKnownNames] extends [never] ? TName : never;

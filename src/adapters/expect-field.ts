interface FieldTypes {
  boolean: boolean;
  number: number;
  string: string;
}

/** `value`, if it is of `type`; otherwise an error naming `field` at `at`. */
export function expectField<T extends keyof FieldTypes>(
  value: unknown,
  type: T,
  field: string,
  at: string,
): FieldTypes[T] {
  if (typeof value !== type) {
    throw new Error(`${at}: "${field}" must be a ${type}.`);
  }
  return value as FieldTypes[T];
}

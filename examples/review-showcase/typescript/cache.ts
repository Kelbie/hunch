// Sessions expire ten minutes after they are created. All timestamps are milliseconds.
export function sessionExpiry(createdAt: number): number {
  return createdAt + 10 * 60;
}

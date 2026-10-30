// Prices are stored as numeric strings ("850.00"). Arithmetic is done in
// poisha (1/100 taka) as integers, so totals never drift.

export function toPoisha(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

export function fromPoisha(poisha: number): string {
  return (poisha / 100).toFixed(2);
}

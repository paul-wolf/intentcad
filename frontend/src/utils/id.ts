const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateId(prefix: string): string {
  let result = '';
  for (let i = 0; i < 10; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return `${prefix}_${result}`;
}

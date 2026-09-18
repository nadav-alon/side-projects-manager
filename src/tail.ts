/** The last `limit` characters of `text`, marked as a tail when it is one. */
export function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(-limit)}`;
}

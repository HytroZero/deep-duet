/** Truncate by code point so surrogate pairs (emoji, rare CJK) are never split. */
export function summarize(text: string, limit = 500) {
  const characters = Array.from(text)
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : text
}

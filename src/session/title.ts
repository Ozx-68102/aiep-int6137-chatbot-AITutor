const maxTitleLength = 500;

export function titleFromQuestion(question: string): string {
  const trimmed = question.trim();
  if (trimmed.length <= maxTitleLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxTitleLength);
}

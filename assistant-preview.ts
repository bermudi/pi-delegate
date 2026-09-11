/** Human-facing, bounded text preview. Never includes thinking blocks or reads
 * transcripts from disk. Updates replace the current response, not append
 * streaming snapshots; completed responses remain available for scrollback. */
export class AssistantPreview {
  private completed = "";
  private current = "";
  static readonly limit = 32_768;

  update(text: string): void {
    // Empty synthetic provider failures must not erase a streamed response.
    if (text) this.current = text.slice(-AssistantPreview.limit);
  }

  finish(text: string): void {
    this.update(text);
    if (this.current) {
      this.completed = [this.completed, this.current]
        .filter(Boolean)
        .join("\n\n")
        .slice(-AssistantPreview.limit);
      this.current = "";
    }
  }

  get text(): string {
    return [this.completed, this.current]
      .filter(Boolean)
      .join("\n\n")
      .slice(-AssistantPreview.limit);
  }
}

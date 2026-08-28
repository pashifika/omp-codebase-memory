/**
 * Markdown imported as text.
 *
 * `bun build` inlines an `import … with { type: "text" }` as a string literal,
 * which is how the shipped skill reaches `src/tools.ts` without a runtime file
 * read or an assumption about where the bundle ended up on disk. `tsc` has no
 * built-in knowledge of the attribute, so the module shape is declared here.
 */
declare module "*.md" {
  const content: string;
  export default content;
}
